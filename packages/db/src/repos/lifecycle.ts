/**
 * Lifecycle closing (Phase F2) — the FIRST writers of `lifecycle_state = 'closed'`. Retrieval already
 * filters `lifecycle_state = 'active'` unconditionally (retrieval.ts), so writing 'closed' is a complete,
 * permanent, user-preference-independent exclusion from every future digest. The writers live here:
 *
 *   - sweepLifecycle (Arm A): the per-board feed-absence sweep, run after a successful upsert. [F2b/F2c]
 *   - closeJobsForCompanies (Arm B): the board-death bulk close, run beside deactivateStale.   [F2d]
 *
 * Both are single race-safe neon-http UPDATEs with SQL-side counter math (never read-modify-write — the
 * markProbeResult idiom, discovery.ts), because neon-http is autocommit and NO transaction wraps the
 * upsert + sweep (client.ts). Worker-safe: pure @opusfinder/db SQL, nothing on the isolation deny-lists.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../client";
import { jobs } from "../schema";
import { intArrayLiteral, NUL, resultRows } from "./sql";

/**
 * Consecutive trusted-fetch absences before an active job is soft-closed (fork F2-THRESHOLD, RATIFIED 3).
 * Measured in ingestion cycles, not wall-clock. The streak is hysteresis against a momentarily-
 * unparseable-but-live posting (a `mapItem` soft-skip drops one posting per fetch, run-adapter.ts) looking
 * "absent" for a single fetch; closing on first absence would silently drop a live role. NB the streak
 * counts increment-EVENTS, not independent-in-time fetches — two overlapping ingests of one board advance
 * an absent job by 2 (see the runbook no-overlap rule); it cannot over-close (a closed row fails the next
 * sweep's `lifecycle_state = 'active'` predicate).
 */
export const ABSENCE_CLOSE_THRESHOLD = 3;

/** The per-board outcome of one sweep, tallied onto `source_runs.counts` by the ingest caller. */
export interface SweepResult {
  /** Jobs reset to a clean active state because they reappeared in the fetch — both a closed→active
   *  revival and a non-zero streak reset to 0 (the two are not distinguished in the counter; the live
   *  gate asserts the actual row transition). */
  revived: number;
  /** Absent jobs whose streak was incremented but is still BELOW the close threshold. */
  swept: number;
  /** Jobs actually flipped to 'closed' this run. ENFORCE mode only — always 0 in count-only (shadow). */
  closed: number;
  /** Absent jobs at/over the close threshold this run that were NOT closed because the sweep ran in
   *  count-only (F2-SHADOW) mode — the standing "would be closed if enforced" population. Always 0 in
   *  enforce mode (those rows are counted under `closed`). */
  wouldClose: number;
}

export interface SweepOptions {
  /** Close threshold; defaults to ABSENCE_CLOSE_THRESHOLD. */
  threshold?: number;
  /** When false (default — F2-SHADOW count-only first), increment the streak and revive reappearing jobs
   *  but DO NOT write 'closed'; tally would-be closes as `wouldClose`. When true (F2-enforce), write
   *  'closed' at the threshold. The ratified rollout ships shadow first, then flips this on after the
   *  real-traffic counters are read. */
  enforce?: boolean;
}

/**
 * Soft-close jobs that have disappeared from a company's board (streak hysteresis) and revive any that
 * reappeared — in ONE race-safe UPDATE, scoped to ONE company (decision 4: NEVER a run-level seen-set,
 * the cron processes only a ≤150-board chunk per tick). `presentExternalIds` is the de-duplicated
 * external_id list the board's fetch just produced (== what upsertJobs persisted).
 *
 * Lives OUTSIDE upsertJobs because a reappearing closed job must revive even when its content is
 * byte-unchanged, which upsertJobs's content-gated setWhere cannot do (jobs.ts:169-173 invariant).
 *
 * HARD no-op on an empty present set (decision 5): `<> ALL('{}')` is TRUE for every row and would close
 * the whole board — belt-and-suspenders behind F2c's `total > 0` call-gate.
 */
export async function sweepLifecycle(
  db: Db,
  companyId: number,
  presentExternalIds: string[],
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const zero: SweepResult = { revived: 0, swept: 0, closed: 0, wouldClose: 0 };
  if (presentExternalIds.length === 0) return zero;

  const threshold = Math.trunc(opts.threshold ?? ABSENCE_CLOSE_THRESHOLD);
  const enforce = opts.enforce ?? false;

  // The present set rides as ONE jsonb param (driver-escaped — no fragile array-literal escaping), unnested
  // to a text[] in a CTE so it binds once and every branch references it. NUL is stripped defensively
  // (jsonb rejects a NUL byte; a successfully-persisted external_id is already NUL-free, so this never fires).
  const presentJson = JSON.stringify(presentExternalIds.map((id) => id.replaceAll(NUL, "")));

  // ENFORCE writes 'closed' at the threshold. SHADOW (count-only) OMITS the close branch entirely, so a
  // crossing row stays active and is only TALLIED as wouldClose — the structural suppression behind the
  // observe-before-enforce rollout. (Tallies below read post-UPDATE lifecycle_state / consecutive_absences.)
  //
  // The streak SET caps at the threshold (`LEAST`): in shadow, with no close branch, an ever-absent active
  // job would otherwise increment every sweep forever and overflow smallint. The cap bounds it; enforce still
  // closes because the close branch reads the un-capped `consecutive_absences + 1` and the WHERE has no
  // `< threshold` guard, so a capped row still matches and flips to 'closed' on the first enforced sweep.
  const closeBranch = enforce
    ? sql`WHEN jobs.consecutive_absences + 1 >= ${threshold} THEN 'closed' `
    : sql``;

  const result: unknown = await db.execute(sql`
    WITH present_set AS (
      SELECT array_agg(value) AS ids
      FROM jsonb_array_elements_text(${presentJson}::jsonb) AS value
    ),
    swept AS (
      UPDATE ${jobs} SET
        consecutive_absences = CASE
          WHEN jobs.external_id = ANY(present_set.ids) THEN 0
          ELSE LEAST(jobs.consecutive_absences + 1, ${threshold})
        END,
        lifecycle_state = CASE
          WHEN jobs.external_id = ANY(present_set.ids) THEN 'active'
          ${closeBranch}ELSE jobs.lifecycle_state
        END,
        updated_at = now()
      FROM present_set
      WHERE jobs.company_id = ${companyId} AND (
        (jobs.external_id = ANY(present_set.ids)
          AND (jobs.lifecycle_state <> 'active' OR jobs.consecutive_absences <> 0))
        OR (jobs.external_id <> ALL(present_set.ids) AND jobs.lifecycle_state = 'active')
      )
      RETURNING
        (jobs.external_id = ANY(present_set.ids)) AS present,
        jobs.lifecycle_state AS new_state,
        jobs.consecutive_absences AS new_streak
    )
    SELECT
      count(*) FILTER (WHERE present)                                            AS revived,
      count(*) FILTER (WHERE NOT present AND new_state = 'closed')               AS closed,
      count(*) FILTER (WHERE NOT present AND new_state <> 'closed'
                            AND new_streak >= ${threshold})                      AS would_close,
      count(*) FILTER (WHERE NOT present AND new_state <> 'closed'
                            AND new_streak <  ${threshold})                      AS swept
    FROM swept
  `);

  const row = resultRows(result)[0] as Record<string, unknown> | undefined;
  if (!row) return zero;
  return {
    revived: Number(row.revived ?? 0),
    swept: Number(row.swept ?? 0),
    closed: Number(row.closed ?? 0),
    wouldClose: Number(row.would_close ?? 0),
  };
}

/** The board-death bulk close (Arm B) outcome — tallied onto the discovery run's counts. */
export interface CloseResult {
  /** Active jobs flipped to 'closed' (enforce only; 0 in shadow). */
  closed: number;
  /** Active jobs of the deactivated companies that WOULD close (count-only/shadow; 0 in enforce). */
  wouldClose: number;
}

/**
 * Shared body for the bulk soft-close arms — soft-close every still-active job matching an int[] of either
 * `company_id` (Arm B, board-death) or `id` (Arm C, a dead-link 410 in the digest). One race-safe statement;
 * count-only by default (F2-SHADOW: tally `wouldClose`, write nothing), `enforce` writes 'closed'. int[]
 * literal — safe for integers (the retrieval.ts anti-join idiom); `Math.trunc` is defensive against a stray
 * non-integer. No-op on empty ids — and unlike the feed-absence sweep, an empty set here is harmless
 * (`= ANY('{}')` matches nothing), so it is just an early-out, not a safety guard.
 */
async function closeActiveJobsBy(
  db: Db,
  column: "company_id" | "id",
  ids: number[],
  enforce: boolean,
): Promise<CloseResult> {
  if (ids.length === 0) return { closed: 0, wouldClose: 0 };
  const idList = intArrayLiteral(ids);
  const match =
    column === "id"
      ? sql`id = ANY(${idList}::int[])`
      : sql`company_id = ANY(${idList}::int[])`;

  if (!enforce) {
    const result: unknown = await db.execute(sql`
      SELECT count(*) AS would_close
      FROM ${jobs}
      WHERE ${match} AND lifecycle_state = 'active'
    `);
    const row = resultRows(result)[0] as Record<string, unknown> | undefined;
    return { closed: 0, wouldClose: Number(row?.would_close ?? 0) };
  }

  const result: unknown = await db.execute(sql`
    UPDATE ${jobs} SET lifecycle_state = 'closed', updated_at = now()
    WHERE ${match} AND lifecycle_state = 'active'
    RETURNING id
  `);
  return { closed: resultRows(result).length, wouldClose: 0 };
}

/**
 * Bulk soft-close every still-active job of the given (just-deactivated) companies — the board-death path
 * Arm A is structurally blind to (a deactivated board runs activeOnly:true and is never re-fetched, so its
 * jobs never enter the feed-absence sweep). NOT streak-gated: the company deactivation already carried ~30
 * days of hysteresis (discovery.ts deactivateStale). Reversible — a later live probe reactivates the company
 * (markProbeResult) and the next ingest revives the present jobs via Arm A's presence-reset.
 */
export function closeJobsForCompanies(
  db: Db,
  companyIds: number[],
  opts: { enforce?: boolean } = {},
): Promise<CloseResult> {
  return closeActiveJobsBy(db, "company_id", companyIds, opts.enforce ?? false);
}

/**
 * Soft-close specific jobs by id — Arm C's explicit-410 close (a digest item whose apply URL returned
 * `410 Gone`). Count-only by default (F2-SHADOW); `enforce: true` (F2-enforce) writes 'closed'. A bare 404
 * NEVER reaches here (Arm C drops it from the digest but does not close — only a definitive 410 closes).
 */
export function closeJobsByIds(
  db: Db,
  jobIds: number[],
  opts: { enforce?: boolean } = {},
): Promise<CloseResult> {
  return closeActiveJobsBy(db, "id", jobIds, opts.enforce ?? false);
}
