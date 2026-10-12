import { sql } from "drizzle-orm";

import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";
import { resultRows } from "../src/repos/sql";

/**
 * Flush `jobs.embedding` ahead of an embedding-model swap (e.g. voyage-3-large → voyage-4-large). Two
 * models embed into DIFFERENT spaces and no row records its model, so a mixed corpus silently returns
 * garbage rankings: every old vector must go before the refill. `nearestJobs` skips NULL rows, so it only
 * ever sees the refilled subset. Idempotent.
 *
 * DRY RUN BY DEFAULT — prints how many vectors would be cleared. `--apply` clears them, in id-keyset batches.
 *
 * Before --apply, pause `embed-backlog-drain` in the Inngest dashboard. The drain refills with whatever
 * bundle is DEPLOYED, not this checkout: an Inngest "No change" sync ships no handler code, so a drain still
 * on the previous Vercel deploy refills the whole corpus with the OLD model. Then refill with
 * `pnpm embeddings:backfill` (runs this checkout's EMBED_MODEL), and un-pause the drain only once the live
 * Vercel prod deploy is built from the commit that carries the new EMBED_MODEL.
 *
 * Re-embed the QUERY side too: a stored profile vector keeps the old model until
 * `pnpm profiles:restructure <email>`, so run NO digest until every user is re-embedded.
 *
 *   pnpm --filter @opusfinder/db exec tsx scripts/reset-embeddings.ts           (dry run)
 *   pnpm --filter @opusfinder/db exec tsx scripts/reset-embeddings.ts --apply   (clear every vector)
 */
const BATCH = 2000;

await runScript("ResetEmbeddings", async () => {
  const apply = process.argv.includes("--apply");
  const db = createDb(getDatabaseUrl());

  const before = await db.execute(
    sql`SELECT count(*)::int AS n FROM jobs WHERE embedding IS NOT NULL`,
  );
  const row = resultRows(before)[0] as Record<string, unknown> | undefined;
  const remaining = Number(row?.n ?? 0);
  console.log(`jobs with an embedding to clear: ${remaining}`);
  if (!apply) {
    console.log(
      "DRY RUN — nothing cleared. Re-run with `--apply` once embed-backlog-drain is paused.",
    );
    return;
  }

  let total = 0;
  for (;;) {
    const res = await db.execute(sql`
      WITH batch AS (SELECT id FROM jobs WHERE embedding IS NOT NULL ORDER BY id LIMIT ${BATCH})
      UPDATE jobs SET embedding = NULL WHERE id IN (SELECT id FROM batch) RETURNING id`);
    const n = resultRows(res).length;
    total += n;
    if (n > 0) console.log(`cleared ${total} ...`);
    if (n < BATCH) break;
  }

  console.log(
    `done — cleared ${total} embedding(s). Refill with \`pnpm embeddings:backfill\`, and re-embed each ` +
      `user profile (\`pnpm profiles:restructure <email>\`) before any digest.`,
  );
});
