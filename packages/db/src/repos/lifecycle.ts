/**
 * Lifecycle closing — the FIRST writers of `lifecycle_state = 'closed'`. Retrieval already filters
 * `lifecycle_state = 'active'` unconditionally (retrieval.ts), so writing 'closed' is a complete,
 * permanent, user-preference-independent exclusion from every future digest. The writers live here:
 *
 *   - sweepLifecycle: the per-board feed-absence sweep, run after a successful upsert.
 *   - closeJobsForCompanies: the board-death bulk close, run beside deactivateStale.
 *
 * Both are single race-safe neon-http UPDATEs with SQL-side counter math (never read-modify-write),
 * because neon-http is autocommit and NO transaction wraps the upsert + sweep (client.ts). Worker-safe:
 * pure @opusfinder/db SQL, nothing on the isolation deny-lists.
 *
 * Both writers ALSO maintain the `jobs.closed_at` clock: stamp now() when a job flips to 'closed', clear
 * to NULL when a job revives — the staleness clock the prune (prune-stale-jobs.ts) keys on. The stamp
 * rides the SAME enforce gate as the close itself, so shadow mode writes neither.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../client";
import { companies, jobs } from "../schema";
import { intArrayLiteral, NUL, resultRows } from "./sql";

/**
 * Consecutive trusted-fetch absences before an active job is soft-closed. Measured in ingestion cycles,
 * not wall-clock. The streak is hysteresis against a momentarily-unparseable-but-live posting (a `mapItem`
 * soft-skip drops one posting per fetch, run-adapter.ts) looking "absent" for a single fetch; closing on
 * first absence would silently drop a live role. NB the streak counts increment-EVENTS, not
 * independent-in-time fetches — two overlapping ingests of one board advance an absent job by 2 (see the
 * runbook no-overlap rule); it cannot over-close (a closed row fails the next sweep's
 * `lifecycle_state = 'active'` predicate).
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
   *  count-only (shadow) mode — the standing "would be closed if enforced" population. Always 0 in
   *  enforce mode (those rows are counted under `closed`). */
  wouldClose: number;
}

export interface SweepOptions {
  /** Close threshold; defaults to ABSENCE_CLOSE_THRESHOLD. */
  threshold?: number;
  /** When false (default — count-only), increment the streak and revive reappearing jobs but DO NOT write
   *  'closed'; tally would-be closes as `wouldClose`. When true, write 'closed' at the threshold. */
  enforce?: boolean;
}

/**
 * Soft-close jobs that have disappeared from a company's board (streak hysteresis) and revive any that
 * reappeared — in ONE race-safe UPDATE, scoped to ONE company (NEVER a run-level seen-set, the cron
 * processes only a ≤150-board chunk per tick). `presentExternalIds` is the de-duplicated external_id list
 * the board's fetch just produced (== what upsertJobs persisted).
 *
 * Lives OUTSIDE upsertJobs because a reappearing closed job must revive even when its content is
 * byte-unchanged, which upsertJobs's content-gated setWhere cannot do.
 *
 * HARD no-op on an empty present set: `<> ALL('{}')` is TRUE for every row and would close the whole
 * board — belt-and-suspenders behind the `total > 0` call-gate.
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

  // The `closed_at` clock, in LOCKSTEP with closeBranch (the SAME `+ 1 >= threshold` condition), so
  // closed_at is stamped to now() EXACTLY when lifecycle_state flips to 'closed', empty in shadow (no
  // close → no stamp), and cleared to NULL on revival (the closed_at CASE's present-branch) — the
  // invariant: closed_at is non-NULL iff the row is currently in a closed episode.
  const closedAtBranch = enforce
    ? sql`WHEN jobs.consecutive_absences + 1 >= ${threshold} THEN now() `
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
        closed_at = CASE
          WHEN jobs.external_id = ANY(present_set.ids) THEN NULL
          ${closedAtBranch}ELSE jobs.closed_at
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

/**
 * Outcome of a bulk soft-close, tallied onto the run's counts. Shared by every bulk closer
 * ({@link closeJobsForCompanies}, {@link closeJobsByIds}, and the staleness timer {@link sweepStaleJobs})
 * since all have the identical shadow/enforce shape; the caller names the per-call counters
 * (e.g. closed→staleClosed, wouldClose→staleWouldClose for the timer).
 */
export interface CloseResult {
  /** Active jobs flipped to 'closed' this run (enforce only; always 0 in shadow/count-only). */
  closed: number;
  /** Active jobs that WOULD close (count-only/shadow standing population; always 0 in enforce). */
  wouldClose: number;
}

/**
 * Shared body for the bulk soft-close paths — soft-close every still-active job matching an int[] of either
 * `company_id` (board-death) or `id` (a dead-link 410 in the digest). One race-safe statement; count-only
 * by default (tally `wouldClose`, write nothing), `enforce` writes 'closed'. int[] literal — safe for
 * integers; `Math.trunc` is defensive against a stray non-integer. No-op on empty ids — and unlike the
 * feed-absence sweep, an empty set here is harmless (`= ANY('{}')` matches nothing), so it is just an
 * early-out, not a safety guard.
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
    column === "id" ? sql`id = ANY(${idList}::int[])` : sql`company_id = ANY(${idList}::int[])`;

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
    UPDATE ${jobs} SET lifecycle_state = 'closed', closed_at = now(), updated_at = now()
    WHERE ${match} AND lifecycle_state = 'active'
    RETURNING id
  `);
  return { closed: resultRows(result).length, wouldClose: 0 };
}

/**
 * Bulk soft-close every still-active job of the given (just-deactivated) companies — the board-death path
 * the feed-absence sweep is structurally blind to (a deactivated board runs activeOnly:true and is never
 * re-fetched, so its jobs never enter that sweep). NOT streak-gated: the company deactivation already
 * carried ~30 days of hysteresis (discovery.ts deactivateStale). Reversible — a later live probe
 * reactivates the company (markProbeResult) and the next ingest revives the present jobs via the
 * presence-reset.
 */
export function closeJobsForCompanies(
  db: Db,
  companyIds: number[],
  opts: { enforce?: boolean } = {},
): Promise<CloseResult> {
  return closeActiveJobsBy(db, "company_id", companyIds, opts.enforce ?? false);
}

/**
 * Soft-close specific jobs by id — the explicit-410 close (a digest item whose apply URL returned
 * `410 Gone`). Count-only by default; `enforce: true` writes 'closed'. A bare 404 NEVER reaches here (it
 * is dropped from the digest but does not close — only a definitive 410 closes).
 */
export function closeJobsByIds(
  db: Db,
  jobIds: number[],
  opts: { enforce?: boolean } = {},
): Promise<CloseResult> {
  return closeActiveJobsBy(db, "id", jobIds, opts.enforce ?? false);
}

/**
 * The completeness-INDEPENDENT positive "I saw this job live" writer, called per board from runIngestion
 * for the de-duplicated external_ids a fetch returned. It (1) refreshes last_seen_at (the staleness clock
 * {@link sweepStaleJobs} keys on) and (2) REVIVES any reappearing closed job (lifecycle_state→'active',
 * closed_at→NULL, streak→0). Runs for EVERY board, capped or not — UNLIKE the set-difference sweep
 * (sweepLifecycle), which is skipped on a capped/partial fetch; this is the path that lets a capped
 * mega-board's jobs both stay fresh AND revive on reappearance.
 *
 * Separate from upsertJobs (pure content persistence) and from its content-gated ON CONFLICT SET:
 * last_seen_at must advance on every re-fetch even when content is byte-unchanged, and reviving a closed
 * row must NOT be content-gated (the same reason sweepLifecycle lives outside upsertJobs). All written
 * columns are UN-indexed ⇒ HOT-eligible. A NO-OP GUARD in the WHERE skips rows already fresh-and-active, so
 * an unchanged board does NOT rewrite every present row every tick (which would defeat upsertJobs'
 * idempotency + churn dead tuples): a row is touched only if its clock is stale (>1h — far inside the
 * ≥~daily re-fetch cadence and the multi-week TTL) OR it needs reviving. Returns `revived` = closed→active
 * revivals only; the streak-reset-only revivals of still-active rows stay sweepLifecycle's `revived`, so
 * runIngestion sums the two for the true total.
 *
 * The present set rides as ONE jsonb param, unnested to text[] (no array-literal escaping; NUL stripped,
 * jsonb rejects it). Empty set ⇒ skip the round-trip (no `<> ALL` trap here).
 */
export async function markJobsPresent(
  db: Db,
  companyId: number,
  presentExternalIds: string[],
): Promise<{ revived: number }> {
  if (presentExternalIds.length === 0) return { revived: 0 };
  const presentJson = JSON.stringify(presentExternalIds.map((id) => id.replaceAll(NUL, "")));
  // revived_set snapshots the to-be-revived (currently-closed) rows BEFORE upd runs — all CTEs see the
  // statement-start snapshot, so the count is the pre-update closed population regardless of CTE exec order.
  const result: unknown = await db.execute(sql`
    WITH present_set AS (
      SELECT array_agg(value) AS ids
      FROM jsonb_array_elements_text(${presentJson}::jsonb) AS value
    ),
    revived_set AS (
      SELECT jobs.id
      FROM ${jobs}, present_set
      WHERE jobs.company_id = ${companyId}
        AND jobs.external_id = ANY(present_set.ids)
        AND jobs.lifecycle_state <> 'active'
    ),
    upd AS (
      UPDATE ${jobs} SET
        last_seen_at = now(),
        lifecycle_state = 'active',
        closed_at = NULL,
        consecutive_absences = CASE
          WHEN jobs.lifecycle_state <> 'active' THEN 0
          ELSE jobs.consecutive_absences
        END
      FROM present_set
      WHERE jobs.company_id = ${companyId}
        AND jobs.external_id = ANY(present_set.ids)
        AND (
          jobs.last_seen_at < now() - interval '1 hour'
          OR jobs.lifecycle_state <> 'active'
          OR jobs.closed_at IS NOT NULL
        )
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM revived_set) AS revived
  `);
  const row = resultRows(result)[0] as Record<string, unknown> | undefined;
  return { revived: Number(row?.revived ?? 0) };
}

/**
 * Stamp companies.last_ingested_at = now() to record a SUCCESSFUL, non-empty fetch of this board.
 * runIngestion calls it only when total>0 (an empty/ambiguous fetch must not certify health).
 * {@link sweepStaleJobs} requires this stamp to be recent, so a board that fails or empties for >TTL is
 * not certified and its still-live jobs are SPARED from the timer.
 */
export async function markCompanyIngested(db: Db, companyId: number): Promise<void> {
  await db.execute(sql`UPDATE ${companies} SET last_ingested_at = now() WHERE id = ${companyId}`);
}

/**
 * Default staleness-close TTL (in DAYS): an active job not re-confirmed (last_seen_at stamped by
 * {@link markJobsPresent}) within this many days soft-closes — IF its board is still being ingested (the
 * board-health guard, see {@link sweepStaleJobs}). MUST comfortably exceed the worst-case full-sweep
 * latency. 21d gives ample margin and sits past the ~14d retrieval recency window, so a not-yet-closed
 * stale job is already invisible to digests and erring long costs nothing user-visible. The Worker
 * overrides via STALE_SWEEP_TTL_DAYS.
 */
export const DEFAULT_STALE_TTL_DAYS = 21;

/**
 * The UNIVERSAL staleness closer — the completeness-INDEPENDENT lifecycle backstop that covers EVERY
 * board, including a permanently-capped mega-board (boschgroup) that SKIPS the complete-feed set-difference
 * sweep. It closes an active job whose `last_seen_at` (stamped by {@link markJobsPresent} on every fetch
 * that returned it) is older than `ttlDays` — gated by the BOARD-HEALTH guard below — so an aged-out /
 * vanished posting closes on the same clock regardless of how its board is fetched. The set-difference
 * stays a FAST-PATH for boards we see completely; this timer is the floor under all of them.
 *
 * BOARD-HEALTH GUARD (joins companies): a job closes ONLY if its company was SUCCESSFULLY ingested within the
 * same TTL window (`c.last_ingested_at >= cutoff`, stamped by {@link markCompanyIngested}). A board that is
 * DOWN/empty for >TTL has last_ingested_at older than the window (or NULL pre-first-ingest), so its still-live
 * jobs are SPARED — NOT false-closed because the cron simply couldn't fetch them. Using the SAME cutoff for
 * the job-staleness and the board-health window makes a failing board's jobs become stale-eligible and
 * board-excluded at the same moment. A HEALTHY capped board keeps last_ingested_at fresh, so its aged-out
 * tail still closes (the intended FRESHNESS close — see schema.ts last_seen_at; those jobs are past recency
 * and revive if they re-enter the fetch window).
 *
 * GLOBAL (all healthy companies), not per-board — the signal is time, not feed presence, so there is no
 * complete-feed precondition and no empty-set trap (`= ANY`/JOIN here, never `<> ALL`). count-only by DEFAULT
 * (shadow — tally `wouldClose`, write nothing); `enforce` writes 'closed' and stamps the `closed_at` clock,
 * like closeActiveJobsBy. `COALESCE(last_seen_at, created_at)` is defensive only. Worker-safe (pure
 * @opusfinder/db SQL). Ships SHADOW-first under its OWN switch (STALE_SWEEP), INDEPENDENT of LIFECYCLE_CLOSE_ENFORCE, so
 * its would-close population is read on real traffic before any close. NOTE for the shadow gate: the FIRST
 * enforce closes a one-time BACKLOG (every healthy capped board's accumulated aged-out tail, expected
 * sizable); steady-state `staleWouldClose` should then be a trickle. Read the per-board breakdown
 * (`pnpm shadow-closes`) so a big capped-board contribution isn't mistaken for a bug.
 */
export async function sweepStaleJobs(
  db: Db,
  opts: { ttlDays?: number; enforce?: boolean } = {},
): Promise<CloseResult> {
  const ttlDays = Math.max(1, Math.trunc(opts.ttlDays ?? DEFAULT_STALE_TTL_DAYS));
  const enforce = opts.enforce ?? false;
  // `${ttlDays}::int` (a Math.trunc'd in-code/env integer, never raw input) * interval — `::` binds tighter
  // than `*`, so `($n::int) * (interval '1 day')`. ONE cutoff drives both the job-staleness test and the
  // board-health window (so a failing board's jobs become stale-eligible and excluded together).
  const cutoff = sql`now() - ${ttlDays}::int * interval '1 day'`;
  const stale = sql`jobs.lifecycle_state = 'active'
      AND COALESCE(jobs.last_seen_at, jobs.created_at) < ${cutoff}
      AND c.last_ingested_at >= ${cutoff}`;

  // SHADOW (count-only): never UPDATE — just tally the standing stale-AND-board-healthy population.
  if (!enforce) {
    const result: unknown = await db.execute(sql`
      SELECT count(*) AS would_close
      FROM ${jobs} JOIN ${companies} c ON c.id = jobs.company_id
      WHERE ${stale}
    `);
    const row = resultRows(result)[0] as Record<string, unknown> | undefined;
    return { closed: 0, wouldClose: Number(row?.would_close ?? 0) };
  }

  // ENFORCE: close + stamp the closed_at clock (G2 prune reads it). RETURNING count is the closed total.
  const result: unknown = await db.execute(sql`
    UPDATE ${jobs} SET lifecycle_state = 'closed', closed_at = now(), updated_at = now()
    FROM ${companies} c
    WHERE jobs.company_id = c.id AND ${stale}
    RETURNING jobs.id
  `);
  return { closed: resultRows(result).length, wouldClose: 0 };
}
