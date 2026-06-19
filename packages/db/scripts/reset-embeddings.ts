import { sql } from "drizzle-orm";

import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";

/**
 * One-time reset of `jobs.embedding` ahead of an embedding-model swap (e.g. voyage-3-large →
 * voyage-4-large). The two models produce vectors in DIFFERENT embedding spaces, so an existing
 * voyage-3 vector cannot be cosine-compared against a new voyage-4 query vector — the whole corpus
 * must be re-embedded. This NULLs every embedding in id-keyset batches (the same shape as
 * reclaim-raw.ts). Flushing leaves ZERO old-model vectors, so the jobs corpus can safely refill
 * with the CURRENT model (EMBED_MODEL in @opusfinder/embeddings) gradually — `nearestJobs` skips
 * NULL rows, so it only ever sees the refilled (new-model) subset. Idempotent: a second run finds 0.
 *
 * Refill jobs over time on the next embedding run, OR `pnpm embeddings:backfill` to refill all now.
 * EITHER WAY, re-embed the QUERY side once first: the stored user-profile vector does NOT drift, so
 * re-embed each user with `pnpm profiles:restructure <email>` and run NO digest until they are on the
 * new model — else `nearestJobs` compares an old-model profile against new-model jobs (garbage scores).
 *
 *   pnpm --filter @opusfinder/db exec tsx scripts/reset-embeddings.ts
 */
const BATCH = 2000;

await runScript("ResetEmbeddings", async () => {
  const db = createDb(getDatabaseUrl());

  const before = await db.execute(
    sql`SELECT count(*)::int AS n FROM jobs WHERE embedding IS NOT NULL`,
  );
  const remaining = Number(rows(before)[0]?.n ?? 0);
  console.log(`jobs with an embedding to clear: ${remaining}`);

  let total = 0;
  for (;;) {
    const res = await db.execute(sql`
      WITH batch AS (SELECT id FROM jobs WHERE embedding IS NOT NULL ORDER BY id LIMIT ${BATCH})
      UPDATE jobs SET embedding = NULL WHERE id IN (SELECT id FROM batch) RETURNING id`);
    const n = rows(res).length;
    total += n;
    if (n > 0) console.log(`cleared ${total} ...`);
    if (n < BATCH) break;
  }

  console.log(
    `done — cleared ${total} embedding(s). Jobs refill with the current model on the next embedding ` +
      `run (or \`pnpm embeddings:backfill\` to refill all now). REQUIRED before any digest: re-embed ` +
      `each user profile (query side) — it does NOT drift — via \`pnpm profiles:restructure <email>\`.`,
  );
});

function rows(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  if (res && typeof res === "object" && "rows" in res) {
    return (res as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [res as Record<string, unknown>];
}
