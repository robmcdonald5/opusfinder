import { sql } from "drizzle-orm";

import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";

/**
 * One-time reclaim of the DEPRECATED `jobs.raw` column. `upsertJobs` stopped writing it
 * (it was write-only debug data that grew to ~90% of the DB and exhausted the Neon storage
 * limit). This NULLs every existing `raw` in id-keyset batches so the space becomes reusable.
 *
 * RUN ONLY AFTER the Neon plan is upgraded — on a full DB this UPDATE itself cannot extend
 * disk and will fail (code 53100). NULLing makes the freed pages reusable by future inserts;
 * to actually SHRINK the project size (e.g. to return to a smaller plan), run `VACUUM FULL jobs;`
 * once afterward via the Neon SQL editor (it rewrites the table — needs an exclusive lock + brief
 * headroom — so neon-http can't run it cleanly).
 *
 *   pnpm --filter @opusfinder/db exec tsx scripts/reclaim-raw.ts
 */
const BATCH = 2000;

await runScript("ReclaimRaw", async () => {
  const db = createDb(getDatabaseUrl());

  const before = await db.execute(
    sql`SELECT count(*)::int AS n FROM jobs WHERE raw IS NOT NULL`,
  );
  const remaining = Number(rows(before)[0]?.n ?? 0);
  console.log(`jobs with raw to clear: ${remaining}`);

  let total = 0;
  for (;;) {
    const res = await db.execute(sql`
      WITH batch AS (SELECT id FROM jobs WHERE raw IS NOT NULL ORDER BY id LIMIT ${BATCH})
      UPDATE jobs SET raw = NULL WHERE id IN (SELECT id FROM batch) RETURNING id`);
    const n = rows(res).length;
    total += n;
    if (n > 0) console.log(`cleared ${total} ...`);
    if (n < BATCH) break;
  }

  const size = await db.execute(
    sql`SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size`,
  );
  console.log(`done — cleared ${total} rows. DB size now: ${JSON.stringify(rows(size)[0])}`);
  console.log("To physically shrink, run `VACUUM FULL jobs;` once in the Neon SQL editor.");
});

function rows(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  if (res && typeof res === "object" && "rows" in res) {
    return (res as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [res as Record<string, unknown>];
}
