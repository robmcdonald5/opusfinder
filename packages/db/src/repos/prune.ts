/**
 * Phase G2b — the TTL hard-delete prune (the reclaim half of the lifecycle: F2/G1 soft-CLOSE jobs,
 * this physically DELETEs the long-closed, history-unreferenced ones so the table + its 1024-dim HNSW
 * index stop growing monotonically). Pure neon-http SQL (db.execute), Worker-safe by construction — but
 * NOT imported by the Worker (only the Node `prune-stale-jobs.ts` script + its smoke use it). Lives here,
 * beside lifecycle.ts, so the prune SQL is tested code (test-prune-stale-jobs.ts) rather than untested
 * inline-in-a-script — the close machinery's pattern. See PHASE_G2_PLAN.md.
 *
 * Deleting a row is FREE (no Voyage call — only ADDING a job costs an embedding) and the space + ANN
 * graph come back via an OUT-OF-BAND VACUUM (neon-http can't VACUUM; the script reminds the owner). The
 * eligibility gate is conservative by construction (see prunablePredicate) so nothing retrievable is ever
 * in scope, and the delete is dry-run-gated in the script.
 */
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../client";
import { resultRows } from "./sql";

/** Closed-for-this-many-days before a row is prunable (fork G2-WINDOW). One-line tunable; 30 is well past
 *  the 14-day retrieval recency, so no job a digest could still surface is ever in scope. */
export const PRUNE_WINDOW_DAYS = 30;

/** id-keyset batch size for the DELETE loop — the reclaim-raw.ts precedent. */
export const PRUNE_BATCH = 2000;

/**
 * The prunable predicate — the conservative THREE-PART eligibility gate (PHASE_G2_PLAN.md decision 2),
 * defined ONCE so the dry-run `prunable` count and the --apply DELETE filter on a BYTE-IDENTICAL
 * condition (the count exactly predicts what --apply removes — the signatureSql parity discipline). A row
 * is prunable IFF all three hold:
 *
 *   1. lifecycle_state = 'closed'                  — never touch an active/retrievable job.
 *   2. closed_at < now() - PRUNE_WINDOW_DAYS       — closed long enough. A NULL closed_at (every active
 *                                                    row, plus any row closed before the 0018 backfill)
 *                                                    fails this comparison and is CONSERVATIVELY skipped.
 *   3. id NOT IN (SELECT job_id FROM digest_items) — referenced by NO digest history. This is
 *                                                    CORRECTNESS, not optimization: digest_items.job_id is
 *                                                    ON DELETE NO ACTION (0007), so deleting a referenced
 *                                                    job would FK-VIOLATE; and that row's content_signature
 *                                                    is the proof alreadyShownSignatures uses to suppress a
 *                                                    repost (digests.ts). NULL-safe because
 *                                                    digest_items.job_id is NOT NULL (no NOT-IN
 *                                                    three-valued-logic trap). Do NOT drop this clause "to
 *                                                    reclaim more", and do NOT switch the FK to CASCADE —
 *                                                    both silently erase the repost-dedup history. (NOT
 *                                                    EXISTS over digest_items_user_id_job_id_idx is an
 *                                                    index-friendlier equivalent if an EXPLAIN ever
 *                                                    warrants it; NOT IN is fine at friends-scale.)
 *
 * Returns a FRESH fragment per call so it can be embedded in multiple statements (the breakdown FILTER and
 * the DELETE CTE) without aliasing a shared instance. The `${n} * interval '1 day'` form is the repo idiom
 * (retrieval.ts / discovery.ts) and binds the window as a param.
 */
export function prunablePredicate(): SQL {
  return sql`lifecycle_state = 'closed'
    AND closed_at < now() - ${PRUNE_WINDOW_DAYS} * interval '1 day'
    AND id NOT IN (SELECT job_id FROM digest_items)`;
}

/** What a prune run did — returned for the script's logging + the smoke's assertions. */
export interface PruneResult {
  /** All closed jobs (the soft-close population F2/G1 produces). */
  closedTotal: number;
  /** Closed jobs past the staleness window — but still possibly digest-referenced. */
  closedOld: number;
  /** Closed + old + UNREFERENCED — the rows the gate would actually delete. */
  prunable: number;
  /** Whether --apply ran the destructive DELETE (false = dry run, wrote nothing). */
  applied: boolean;
  /** Rows actually DELETEd this run (0 on a dry run). */
  deleted: number;
}

/**
 * Run the prune. Default (`apply: false`) is a DRY RUN: it computes + logs the closed_total / closed_old /
 * prunable breakdown and writes NOTHING (PHASE_G2_PLAN.md decision 6 — eyeball `prunable` before the first
 * real delete). With `apply: true` it id-keyset-DELETEs the prunable rows in PRUNE_BATCH chunks until a
 * short batch (the reclaim-raw.ts loop shape; a deleted row trivially no longer matches the predicate, so
 * it always terminates), then logs the DB size delta + the out-of-band VACUUM reminder.
 *
 * IRREVERSIBLE (decision 3): a deleted row is gone (unlike a soft-close, which a revival un-closes). The
 * gate is conservative, and a wrongly-pruned-but-live posting SELF-HEALS — the next ingest re-creates it as
 * a NEW row (new id, re-embedded once); the only loss is row identity, which clause 3 guaranteed was
 * unreferenced. Logs counts + pg_size_pretty ONLY — never a job title/description (the no-PII rule).
 */
export async function pruneStaleJobs(db: Db, opts: { apply?: boolean } = {}): Promise<PruneResult> {
  const apply = opts.apply ?? false;

  // 1) ALWAYS the breakdown first — the gate the owner reads. closed_total ⊇ closed_old ⊇ prunable; the
  //    closed_old − prunable gap is the still-referenced closed rows G2 pins forever by design (a later
  //    G-track candidate — fork G2-SHOWN-HISTORY in PHASE_G2_PLAN.md).
  const breakdown = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE lifecycle_state = 'closed')                                AS closed_total,
      count(*) FILTER (WHERE lifecycle_state = 'closed'
                         AND closed_at < now() - ${PRUNE_WINDOW_DAYS} * interval '1 day') AS closed_old,
      count(*) FILTER (WHERE ${prunablePredicate()})                                    AS prunable
    FROM jobs
  `);
  const row = resultRows(breakdown)[0] as Record<string, unknown> | undefined;
  const closedTotal = Number(row?.closed_total ?? 0);
  const closedOld = Number(row?.closed_old ?? 0);
  const prunable = Number(row?.prunable ?? 0);
  console.log(
    `jobs lifecycle breakdown: closed_total=${closedTotal} ` +
      `closed_old(>=${PRUNE_WINDOW_DAYS}d)=${closedOld} prunable(unreferenced)=${prunable}`,
  );

  if (!apply) {
    console.log("DRY RUN — nothing deleted. Re-run with `--apply` to delete the prunable rows.");
    return { closedTotal, closedOld, prunable, applied: false, deleted: 0 };
  }

  if (prunable === 0) {
    console.log("Nothing to prune — no rows match the eligibility gate.");
    return { closedTotal, closedOld, prunable, applied: true, deleted: 0 };
  }

  const sizeBefore = await dbSize(db);
  console.log(`--apply: deleting ${prunable} prunable row(s). DB size before: ${sizeBefore}`);

  let deleted = 0;
  for (;;) {
    const res = await db.execute(sql`
      WITH batch AS (
        SELECT id FROM jobs WHERE ${prunablePredicate()} ORDER BY id LIMIT ${PRUNE_BATCH}
      )
      DELETE FROM jobs WHERE id IN (SELECT id FROM batch) RETURNING id`);
    const n = resultRows(res).length;
    deleted += n;
    if (n > 0) console.log(`deleted ${deleted} ...`);
    if (n < PRUNE_BATCH) break;
  }

  const sizeAfter = await dbSize(db);
  console.log(`done — deleted ${deleted} row(s). DB size now: ${sizeAfter}`);
  console.log(
    "Reclaim is OUT OF BAND (neon-http can't VACUUM): run `VACUUM jobs;` in the Neon SQL editor to " +
      "repair the HNSW graph + free pages (or `VACUUM FULL jobs;` once to physically shrink the file).",
  );
  return { closedTotal, closedOld, prunable, applied: true, deleted };
}

/** pg_size_pretty(pg_database_size(...)) as a string, for the before/after log lines (reclaim-raw.ts). */
async function dbSize(db: Db): Promise<string> {
  const res = await db.execute(
    sql`SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size`,
  );
  const row = resultRows(res)[0] as Record<string, unknown> | undefined;
  return String(row?.db_size ?? "unknown");
}
