/**
 * The TTL hard-delete prune (the reclaim half of the lifecycle: the soft-CLOSE writers mark jobs closed,
 * this physically DELETEs the long-closed, history-unreferenced ones so the table stops growing
 * monotonically). Pure neon-http SQL (db.execute), Worker-safe by construction: the
 * scrapers Worker runs {@link runPrune} after its weekly discovery run, and the Node `prune-stale-jobs.ts`
 * script runs {@link pruneStaleJobs}.
 *
 * The rule lives in ONE place, the `prune_closed_jobs(max_rows, apply)` SQL function (migration 0028), so the
 * script, the Worker and the dry-run count can't disagree. It is SECURITY DEFINER: the Worker's login has no
 * DELETE, only EXECUTE on this function, so it can delete nothing the rule doesn't allow. A row is prunable
 * IFF all three hold:
 *
 *   1. lifecycle_state = 'closed'                  — never touch an active/retrievable job.
 *   2. closed_at < now() - 30 days                 — closed long enough ({@link PRUNE_WINDOW_DAYS}). A NULL
 *                                                    closed_at fails this comparison and is CONSERVATIVELY
 *                                                    skipped.
 *   3. id NOT IN (SELECT job_id FROM digest_items) — referenced by NO digest history. The
 *                                                    digest_items.job_id FK was dropped, so deleting a
 *                                                    referenced job no longer FK-VIOLATES; this clause is
 *                                                    retained ON PURPOSE as conservatism. Its surviving
 *                                                    correctness reason: a still-live referenced row's
 *                                                    content_signature is the proof alreadyShownSignatures
 *                                                    uses to suppress a repost (digests.ts), so the
 *                                                    suppression lasts only until the row is pruned.
 *                                                    Relaxing it must still keep a job whose digest_items
 *                                                    row has no display snapshot (job_title IS NULL): once
 *                                                    the job is gone that history row has nothing to render.
 *
 * Deleting a row is FREE (no Voyage call — only ADDING a job costs an embedding). The space comes back through
 * autovacuum; neon-http can't VACUUM, so a manual `VACUUM jobs;` is an optional speed-up, not a requirement.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../client";
import { describeDbError } from "../errors";
import { finishRun, startRun } from "./discovery";
import { resultRows } from "./sql";

/** Closed-for-this-many-days before a row is prunable. Must equal the interval in `prune_closed_jobs`
 *  (migration 0028); the integration suite pins the two at the boundary. 30 is well past the 14-day
 *  retrieval recency, so no job a digest could still surface is ever in scope. */
export const PRUNE_WINDOW_DAYS = 30;

/** Rows per `prune_closed_jobs` call (the function itself refuses more than 5000). */
export const PRUNE_BATCH = 2000;

/** The function's signature, as GRANT EXECUTE needs it (roles.ts grants it to the Worker's login). */
export const PRUNE_FUNCTION = "public.prune_closed_jobs(integer, boolean)";

/** What a prune run did — returned for the script's logging + the smoke's assertions. */
export interface PruneResult {
  /** All closed jobs (the soft-close population). */
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

/** The prunable count, by the function's own rule (apply = false writes nothing). */
async function countPrunable(db: Db): Promise<number> {
  const res = await db.execute(sql`SELECT public.prune_closed_jobs(0, false) AS n`);
  return Number((resultRows(res)[0] as Record<string, unknown> | undefined)?.n ?? 0);
}

/** Delete up to `limit` prunable rows; returns how many went. */
async function deleteBatch(db: Db, limit: number): Promise<number> {
  const res = await db.execute(sql`SELECT public.prune_closed_jobs(${limit}, true) AS n`);
  return Number((resultRows(res)[0] as Record<string, unknown> | undefined)?.n ?? 0);
}

/**
 * Delete prunable rows in {@link PRUNE_BATCH} calls until a short batch or `maxRows` (a deleted row no longer
 * matches the rule, so it always terminates). A batch can come back short while more remain, when a row was
 * revived between the function's read and its DELETE; the next run takes the rest.
 */
async function deleteUpTo(
  db: Db,
  maxRows: number,
  onBatch?: (deleted: number) => void,
): Promise<number> {
  let deleted = 0;
  while (deleted < maxRows) {
    const want = Math.min(PRUNE_BATCH, maxRows - deleted);
    const n = await deleteBatch(db, want);
    deleted += n;
    if (n > 0) onBatch?.(deleted);
    if (n < want) break;
  }
  return deleted;
}

/**
 * The owner's script. Default (`apply: false`) is a DRY RUN: it computes + logs the closed_total / closed_old /
 * prunable breakdown and writes NOTHING. With `apply: true` it deletes every prunable row, then logs the DB
 * size delta.
 *
 * IRREVERSIBLE: a deleted row is gone (unlike a soft-close, which a revival un-closes). The gate is
 * conservative, and a wrongly-pruned-but-live posting SELF-HEALS — the next ingest re-creates it as a NEW
 * row (new id, re-embedded once); the only loss is row identity, which clause 3 guaranteed was
 * unreferenced. Logs counts + pg_size_pretty ONLY — never a job title/description (no-PII).
 */
export async function pruneStaleJobs(db: Db, opts: { apply?: boolean } = {}): Promise<PruneResult> {
  const apply = opts.apply ?? false;

  // 1) ALWAYS the breakdown first — the gate the owner reads. closed_total ⊇ closed_old ⊇ prunable; the
  //    closed_old − prunable gap is the still-referenced closed rows pinned forever by design.
  const breakdown = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE lifecycle_state = 'closed')                                AS closed_total,
      count(*) FILTER (WHERE lifecycle_state = 'closed'
                         AND closed_at < now() - ${PRUNE_WINDOW_DAYS} * interval '1 day') AS closed_old
    FROM jobs
  `);
  const row = resultRows(breakdown)[0] as Record<string, unknown> | undefined;
  const closedTotal = Number(row?.closed_total ?? 0);
  const closedOld = Number(row?.closed_old ?? 0);
  const prunable = await countPrunable(db);
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
  const deleted = await deleteUpTo(db, Number.MAX_SAFE_INTEGER, (n) =>
    console.log(`deleted ${n} ...`),
  );
  const sizeAfter = await dbSize(db);
  console.log(`done — deleted ${deleted} row(s). DB size now: ${sizeAfter}`);
  console.log(
    "Postgres reuses the freed space (autovacuum), so the size above won't drop by itself. After a big delete, " +
      "`VACUUM jobs;` in the Neon SQL editor speeds that up.",
  );
  return { closedTotal, closedOld, prunable, applied: true, deleted };
}

/** What the Worker's weekly prune did, also written to its `prune` source_runs row. */
export interface PruneRunCounts {
  /** Prunable before this run deleted anything. */
  prunable: number;
  /** Rows deleted (0 when not applied). */
  deleted: number;
  [key: string]: number;
}

/**
 * The scrapers Worker's weekly prune, recorded as a `prune` source_runs row. `apply: false` (the shipped
 * default, PRUNE unset) only counts; `apply: true` deletes at most `maxRows`, so a backlog drains over several
 * weeks instead of in one long delete. A failure finishes the row as `error` and re-throws, for the caller to
 * log without failing the run it follows.
 */
export async function runPrune(
  db: Db,
  opts: { apply: boolean; maxRows: number },
): Promise<PruneRunCounts> {
  const runId = await startRun(db, "prune");
  try {
    const prunable = await countPrunable(db);
    const deleted =
      opts.apply && prunable > 0 ? await deleteUpTo(db, Math.max(0, opts.maxRows)) : 0;
    const counts: PruneRunCounts = { prunable, deleted };
    await finishRun(db, runId, { status: "ok", counts });
    return counts;
  } catch (err) {
    // describeDbError: a failed query's Postgres reason, redacted, never its params.
    const errorSample = describeDbError(err).slice(0, 500);
    await finishRun(db, runId, { status: "error", counts: {}, errorSample }).catch(() => {});
    throw err;
  }
}

/** pg_size_pretty(pg_database_size(...)) as a string, for the before/after log lines. */
async function dbSize(db: Db): Promise<string> {
  const res = await db.execute(
    sql`SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size`,
  );
  const row = resultRows(res)[0] as Record<string, unknown> | undefined;
  return String(row?.db_size ?? "unknown");
}
