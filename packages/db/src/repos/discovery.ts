/**
 * Persistence for the slug-discovery pipeline (Phase 7): run-tracking via `source_runs` and
 * the `companies` staleness lifecycle. Same functional style as ./jobs and ./embeddings — the
 * Drizzle client is injected, every mutation is a single neon-http round-trip, and all time +
 * counter math happens SQL-side (`now()`, `failures + 1`) so it is race-free and Worker-forward
 * (no Node clock, no read-modify-write). Company INSERTs reuse `upsertCompany` from ./jobs; this
 * module only adds the run audit + the probe-result/staleness transitions.
 */
import { and, eq, sql } from "drizzle-orm";

import type { CompanySlug, SourceName } from "@opusfinder/shared";

import type { Db } from "../client";
import { companies, sourceRuns, type RunCounts, type RunPipeline, type RunStatus } from "../schema";
import type { CompanyRow } from "./jobs";
import { finishRunRow } from "./runs";

// Stale-`running` window. A run never legitimately exceeds the Cloudflare Worker wall limit (15 min)
// — a tick is ~30s — so anything still `running` after this is a zombie from a killed/timed-out
// process. Set well above the max real duration so a slow-but-live concurrent run is never swept.
const DEFAULT_STALE_RUN_MINUTES = 60;

/**
 * Sweep zombie `source_runs` rows. A hard Worker kill / timeout leaves a row stuck `running` — NO
 * code runs to call `finishRun` (a `finally` can't help a terminated isolate), so the only recovery
 * is to clean it up on a later run. Mark any `running` row older than `olderThanMinutes` as `error`
 * with a clear sample. Returns the count swept. Called from `startRun` (Phase-7/8 deferred item —
 * relevant now that the deployed Worker cron can time out). The window protects a live concurrent run.
 */
export async function failStaleRuns(
  db: Db,
  olderThanMinutes = DEFAULT_STALE_RUN_MINUTES,
): Promise<number> {
  const minutes = Math.trunc(olderThanMinutes);
  const rows = await db
    .update(sourceRuns)
    .set({
      status: "error",
      finishedAt: sql`now()`,
      errorSample: "swept: stale running row (process killed or timed out before finishRun)",
    })
    .where(
      and(
        eq(sourceRuns.status, "running"),
        sql`${sourceRuns.startedAt} < now() - ${minutes} * interval '1 minute'`,
      ),
    )
    .returning({ id: sourceRuns.id });
  return rows.length;
}

/**
 * Open a run: insert a `running` row (status + started_at come from column defaults) and return
 * its id. Call BEFORE any work so a hard crash leaves a visible `running` row; `finishRun`
 * patches it to a terminal state. `source` is omitted (NULL) for a sweep across all sources.
 * First sweeps zombie `running` rows left by a previously killed/timed-out run (see `failStaleRuns`).
 */
export async function startRun(
  db: Db,
  pipeline: RunPipeline,
  opts: { source?: SourceName } = {},
): Promise<number> {
  await failStaleRuns(db); // cheap no-op when none are stale; keeps source_runs trustworthy
  const rows = await db
    .insert(sourceRuns)
    .values({ pipeline, source: opts.source })
    .returning({ id: sourceRuns.id });

  const row = rows[0];
  if (!row) throw new Error(`startRun inserted no row for pipeline "${pipeline}"`);
  return row.id;
}

/**
 * Close a run: stamp `finished_at`, write the terminal status + the metric bag, and (on error)
 * a truncated, SECRET-FREE sample. Typed to a terminal status only (`running` can't be a
 * finish state). Meant to run in a `finally` so a thrown pipeline still records its outcome.
 * The WHERE includes `status = 'running'` so a run terminalizes exactly ONCE: a double finish
 * (e.g. an inner error handler plus an outer finally) is a no-op and never clobbers the recorded
 * status / counts / error_sample.
 */
export async function finishRun(
  db: Db,
  runId: number,
  result: { status: Exclude<RunStatus, "running">; counts: RunCounts; errorSample?: string },
): Promise<void> {
  await finishRunRow(db, sourceRuns, runId, result);
}

/**
 * The next batch of ACTIVE companies to re-probe, oldest-probed first (`NULLS FIRST` so a
 * never-probed row — e.g. one seeded by a pre-Phase-7 `pnpm ingest` — is checked before any
 * already-probed row). Optionally scoped to one source. Returns the same `{ id, slug, source }`
 * shape `upsertCompany`/ingestion use, so the prober rebuilds the request with the canonical
 * stored slug. Backed by the partial `companies_active_last_probed_idx`.
 */
export function listCompaniesForReprobe(
  db: Db,
  opts: { source?: SourceName; limit: number },
): Promise<CompanyRow[]> {
  // Conditions-array idiom (matching embeddings.ts) so the base active filter isn't duplicated
  // across the optional-source branches. The ORDER BY mirrors companies_active_last_probed_idx
  // exactly (last_probed_at ASC NULLS FIRST, id), so the planner range-scans the partial index.
  const conditions = [eq(companies.active, true)];
  if (opts.source) conditions.push(eq(companies.source, opts.source));
  return db
    .select({ id: companies.id, slug: companies.slug, source: companies.source })
    .from(companies)
    .where(and(...conditions))
    .orderBy(sql`${companies.lastProbedAt} asc nulls first`, companies.id)
    .limit(opts.limit);
}

/** A company's identity + lifecycle flag, for the discovery partition. */
export interface CompanyState {
  id: number;
  slug: CompanySlug;
  source: SourceName;
  active: boolean;
}

/**
 * Every company's `(id, slug, source, active)`, optionally scoped to one source. Backs the discovery
 * partition that must route NEW + INACTIVE candidates to the probe path (so a re-discovered dead-then-
 * revived slug can reactivate via `markProbeResult(true)`) and ACTIVE ones to the reprobe pass — which
 * plain `listCompanies` can't drive because it omits `active`.
 */
export function listCompanyStates(
  db: Db,
  opts: { source?: SourceName } = {},
): Promise<CompanyState[]> {
  return db
    .select({
      id: companies.id,
      slug: companies.slug,
      source: companies.source,
      active: companies.active,
    })
    .from(companies)
    .where(opts.source ? eq(companies.source, opts.source) : undefined);
}

/**
 * Record one probe outcome for a company in a SINGLE branchless UPDATE. Every probe stamps
 * `last_probed_at` + `updated_at`. A LIVE probe additionally resets the failure streak to 0,
 * refreshes `last_live_at` (the staleness clock), and re-activates the row — so a slug that comes
 * back to life un-deactivates itself. A FAILED (confirmed-ABSENT) probe increments the streak and
 * leaves `last_live_at` + `active` untouched, so the staleness window keeps counting. Keeping it
 * one statement means the shared stamping can't drift between the live and failed paths; the
 * increment is SQL-side (`failures + 1`) → race-free. ONLY call on a definitive live/absent
 * verdict; an `indeterminate` probe must skip this so it can't drift a healthy row.
 */
export async function markProbeResult(db: Db, companyId: number, live: boolean): Promise<void> {
  await db
    .update(companies)
    .set({
      lastProbedAt: sql`now()`,
      updatedAt: sql`now()`,
      consecutiveProbeFailures: live ? 0 : sql`${companies.consecutiveProbeFailures} + 1`,
      // LIVE-only fields: omitted on a FAILED probe so they stay untouched (no self-assign).
      ...(live ? { lastLiveAt: sql`now()`, active: true } : {}),
    })
    .where(eq(companies.id, companyId));
}

/**
 * Advance ONLY `last_probed_at` (+ `updated_at`), without touching the failure streak,
 * `last_live_at`, or `active` — the "probed but couldn't conclude" stamp for an INDETERMINATE or
 * transient reprobe. Without it such a row never advances `last_probed_at` and stays at the head of
 * the oldest-probed-first reprobe queue forever, starving every row behind it. A definitive
 * live/absent verdict uses `markProbeResult` instead.
 */
export async function markProbed(db: Db, companyId: number): Promise<void> {
  await db
    .update(companies)
    .set({ lastProbedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(companies.id, companyId));
}

/**
 * Deactivate every company whose slug has been failing for at least `olderThanDays` days, decidable
 * from each row alone: ACTIVE, a non-zero failure streak, and a staleness clock
 * COALESCE(last_live_at, created_at) older than the window. The COALESCE falls back to `created_at`
 * for a row a discovery LIVE probe has never refreshed (an ingestion-seeded company with
 * `last_live_at` NULL), so the clock runs from when the row was created. NOTE: this gives the FULL
 * window only to a row created WITHIN it — an ingestion-seeded row created longer ago than
 * `olderThanDays` can be swept on its FIRST confirmed-absent reprobe (its created_at clock is
 * already past). That is acceptable: `absent` is a definitive 404/400 (transients classify as
 * `indeterminate` and never increment the streak), and deactivation is reversible — a later live
 * probe reactivates the row. A true first-failure clock (a `first_failed_at` column) is deferred to
 * the Phase-8 worker. A never-failed row (streak 0) is untouched, so a source whose absence can't be
 * asserted — SmartRecruiters' ambiguous 200, which never increments the streak — never wrongly
 * deactivates.
 * `opts.source` scopes the sweep to one source so a `--source` run doesn't deactivate rows of an
 * unrelated source it never re-probed; omit it (the broader pass) to sweep all sources. Returns the
 * number of rows flipped. `days` is the trunc of an in-code number, never user input.
 */
export async function deactivateStale(
  db: Db,
  olderThanDays = 30,
  opts: { source?: SourceName } = {},
): Promise<number> {
  const days = Math.trunc(olderThanDays);
  const conditions = [
    sql`${companies.active} = true`,
    sql`${companies.consecutiveProbeFailures} > 0`,
    sql`COALESCE(${companies.lastLiveAt}, ${companies.createdAt}) < now() - ${days} * interval '1 day'`,
  ];
  if (opts.source) conditions.push(eq(companies.source, opts.source));
  const rows = await db
    .update(companies)
    .set({ active: false, updatedAt: sql`now()` })
    .where(and(...conditions))
    .returning({ id: companies.id });

  return rows.length;
}
