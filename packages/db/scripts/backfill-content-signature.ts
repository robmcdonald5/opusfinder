import { and, isNull, sql } from "drizzle-orm";

import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";
import { signatureSql } from "../src/repos/sql";
import { resultRows } from "../src/repos/sql";
import { jobs } from "../src/schema";

/**
 * Backfill jobs.content_signature for every still-unsigned row. The SET expression is the
 * IDENTICAL signatureSql used by upsertJobs (INSERT VALUES + ON CONFLICT SET), so a backfilled row's
 * signature is byte-identical to what a future re-ingest would write — no JS write path, no parity drift.
 *
 * Re-runnable: it selects only rows that are NULL but would sign non-NULL, so already-signed rows stop
 * matching and a partial run just resumes next time. A blank-description row signs NULL by design (see
 * signatureSql), so it is neither selected nor counted as unsigned by the gate below. The SET references
 * column expressions only (no per-row bind params), so the 65535 bind-param ceiling and id-keyset chunking
 * don't apply at today's table size — chunk only if the table ever outgrows a single statement.
 *
 *   pnpm db:backfill-signatures            (needs DATABASE_URL)
 */
await runScript("BackfillContentSignature", async () => {
  const db = createDb(getDatabaseUrl());

  const signature = signatureSql(sql`${jobs.title}`, sql`${jobs.descriptionText}`);
  const updated = await db
    .update(jobs)
    .set({ contentSignature: signature })
    .where(and(isNull(jobs.contentSignature), sql`${signature} IS NOT NULL`))
    .returning({ id: jobs.id });
  const signed = updated.length;

  // Acceptance gate: assert no unsigned rows remain. within_group_dups (signed rows minus distinct
  // signatures) is a SIGNAL, not an error — non-zero is EXPECTED once real cross-posts/reposts exist.
  const stats: unknown = await db.execute(sql`
    SELECT count(*)                                              AS total,
           count(*) FILTER (WHERE content_signature IS NULL AND ${signature} IS NOT NULL) AS unsigned,
           count(content_signature) - count(DISTINCT content_signature) AS within_group_dups
    FROM ${jobs}
  `);
  const row = resultRows(stats)[0] as Record<string, unknown> | undefined;
  const total = Number(row?.total ?? 0);
  const unsigned = Number(row?.unsigned ?? 0);
  const withinGroupDups = Number(row?.within_group_dups ?? 0);

  console.log(`Signed ${signed} row(s) this run.`);
  console.log(`jobs: total=${total} unsigned=${unsigned} within_group_dups=${withinGroupDups}`);

  if (unsigned !== 0) {
    throw new Error(
      `Backfill incomplete: ${unsigned} row(s) still NULL after the UPDATE. ` +
        "F1b/F1c are inert for unsigned rows — investigate before relying on them.",
    );
  }
});
