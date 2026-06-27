/**
 * Shared run-row lifecycle helper. Both the discovery/ingestion `source_runs` lane and the
 * `digest_runs` lane track a run the same way: insert a `running` row, then patch it to a terminal
 * state exactly once. The FINISH half is identical across the two tables (same once-only terminalize
 * guard, a subtle invariant worth a single definition), so it lives here; the START halves differ
 * (different insert columns, and `source_runs` sweeps stale rows first), so they stay in ./discovery
 * and ./digests respectively.
 */
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../client";
import { digestRuns, sourceRuns, type RunCounts, type RunStatus } from "../schema";

/** A run-tracking table sharing the lifecycle columns (id, status, finishedAt, counts, errorSample). */
type RunTable = typeof sourceRuns | typeof digestRuns;

/**
 * Terminalize a run row: stamp `finished_at`, write the terminal status + the metric bag, and (on
 * error) a truncated, SECRET-free sample. The `status = 'running'` predicate terminalizes a run exactly
 * ONCE — a double finish (an inner error handler plus an outer `finally`) is a no-op and never clobbers
 * the recorded status / counts / error_sample. Meant to be called from a `finally`.
 */
export async function finishRunRow(
  db: Db,
  table: RunTable,
  runId: number,
  result: { status: Exclude<RunStatus, "running">; counts: RunCounts; errorSample?: string },
): Promise<void> {
  await db
    .update(table)
    .set({
      status: result.status,
      finishedAt: sql`now()`,
      counts: result.counts,
      errorSample: result.errorSample ?? null,
    })
    .where(and(eq(table.id, runId), eq(table.status, "running")));
}
