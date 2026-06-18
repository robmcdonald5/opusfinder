import { sql } from "drizzle-orm";

import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";
import { resultRows } from "../src/repos/sql";

/**
 * Phase G3a — one-time backfill of the digest_items DISPLAY-SNAPSHOT columns (job_title, company_slug,
 * apply_url, locations, remote, migration 0019) for rows that predate G3. New rows are populated at
 * persist (insertDigestItems); this fills the historical ones by copying the fields off the still-live
 * jobs/companies row they reference.
 *
 * Self-consuming keyset loop (the reclaim-raw.ts template): each batch selects up to BATCH rows still
 * missing the snapshot (`job_title IS NULL`), joined to their live job+company, and writes the five
 * fields; the UPDATE flips `job_title` NOT NULL so those rows leave the filter, and the next batch picks
 * the next NULL rows. Terminates on a short batch. IDEMPOTENT — safe to re-run; it only ever touches rows
 * that are still NULL.
 *
 * A row whose job was already pruned (the INNER JOIN can't match) is left NULL and is simply never
 * selected — harmless: pre-G3e nothing is pruned (so every NULL row backfills), and G3e is itself gated
 * on this script having driven the NULL count to 0 first (PHASE_G3_PLAN.md §9 ordering landmine). Logs
 * counts only — never a title/url (titles are public, but the no-PII-in-logs discipline holds).
 *
 *   pnpm --filter @opusfinder/db backfill-snapshots
 *
 * Run AFTER `pnpm db:migrate` applies 0019. Re-run until it reports 0 remaining; that 0 is the gate G3e
 * (the prune-gate relax) and G3c phase 2 (drop the live join) both depend on.
 */
const BATCH = 2000;

await runScript("BackfillDigestItemSnapshot", async () => {
  const db = createDb(getDatabaseUrl());

  const before = await db.execute(
    sql`SELECT count(*)::int AS n FROM digest_items WHERE job_title IS NULL`,
  );
  const remaining = Number((resultRows(before)[0] as { n?: number } | undefined)?.n ?? 0);
  console.log(`digest_items needing a snapshot: ${remaining}`);

  let total = 0;
  for (;;) {
    const res = await db.execute(sql`
      WITH batch AS (
        SELECT di.id, j.title, c.slug AS company_slug, j.apply_url, j.locations, j.remote
        FROM digest_items di
        JOIN jobs j      ON j.id = di.job_id
        JOIN companies c ON c.id = j.company_id
        WHERE di.job_title IS NULL
        ORDER BY di.id
        LIMIT ${BATCH}
      )
      UPDATE digest_items di SET
        job_title    = b.title,
        company_slug = b.company_slug,
        apply_url    = b.apply_url,
        locations    = b.locations,
        remote       = b.remote
      FROM batch b
      WHERE di.id = b.id
      RETURNING di.id`);
    const n = resultRows(res).length;
    total += n;
    if (n > 0) console.log(`backfilled ${total} ...`);
    if (n < BATCH) break;
  }

  const stillNull = await db.execute(
    sql`SELECT count(*)::int AS n FROM digest_items WHERE job_title IS NULL`,
  );
  const left = Number((resultRows(stillNull)[0] as { n?: number } | undefined)?.n ?? 0);
  console.log(
    `done — backfilled ${total} row(s); ${left} still NULL ` +
      `(${left === 0 ? "complete — G3e/G3c-phase-2 unblocked" : "left only if their job was already pruned"}).`,
  );
});
