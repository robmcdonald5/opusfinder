/**
 * Persistence for the slug-discovery pipeline: run-tracking via `source_runs` and
 * the `companies` staleness lifecycle. Same functional style as ./jobs and ./embeddings — the
 * Drizzle client is injected, every mutation is a single neon-http round-trip, and all time +
 * counter math happens SQL-side (`now()`, `failures + 1`) so it is race-free and Worker-forward
 * (no Node clock, no read-modify-write). Company INSERTs reuse `upsertCompany` from ./jobs; this
 * module only adds the run audit + the probe-result/staleness transitions.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import type { CompanySlug, SourceName } from "@opusfinder/shared";

import type { Db } from "../client";
import { companies, sourceRuns, type RunCounts, type RunPipeline, type RunStatus } from "../schema";
import type { CompanyRow } from "./jobs";
import { finishRunRow } from "./runs";

// Stale-`running` window. A Worker run never legitimately exceeds the Cloudflare Worker wall limit
// (15 min), so anything still `running` after this is a zombie from a killed/timed-out process. Set
// well above the max real duration so a slow-but-live concurrent run is never swept. A CLI ingest
// (`ingestion-cli`) has no such limit and walks every board for an hour or more: it gets a day.
const DEFAULT_STALE_RUN_MINUTES = 60;

/**
 * Sweep zombie `source_runs` rows. A hard Worker kill / timeout leaves a row stuck `running` — NO
 * code runs to call `finishRun` (a `finally` can't help a terminated isolate), so the only recovery
 * is to clean it up on a later run. Mark any `running` row older than `olderThanMinutes` as `error`
 * with a clear sample. Returns the count swept. Called from `startRun`. The window protects a live
 * concurrent run.
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
        sql`(${sourceRuns.pipeline} <> 'ingestion-cli' OR ${sourceRuns.startedAt} < now() - interval '1 day')`,
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

/** Close a `source_runs` run: delegates to {@link finishRunRow} (the shared once-only terminalize). */
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
 * revived slug can reactivate via `markProbeResult(true)`) and ACTIVE ones to the reprobe pass.
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
 * refreshes `last_live_at` (part of the staleness clock), and re-activates the row (the only path
 * that does). A FAILED (confirmed-ABSENT) probe increments the streak and leaves `last_live_at` +
 * `active` untouched, so the staleness window keeps counting. Keeping it
 * one statement means the shared stamping can't drift between the live and failed paths; the
 * increment is SQL-side (`failures + 1`) → race-free. ONLY call on a definitive live/absent
 * verdict; an `indeterminate` probe must skip this so it can't drift a healthy row. Takes every
 * company with the same outcome, so a reprobe pass writes hundreds of rows in one round trip.
 */
export async function markProbeResult(db: Db, companyIds: number[], live: boolean): Promise<void> {
  if (companyIds.length === 0) return;
  await db
    .update(companies)
    .set({
      lastProbedAt: sql`now()`,
      updatedAt: sql`now()`,
      consecutiveProbeFailures: live ? 0 : sql`${companies.consecutiveProbeFailures} + 1`,
      // LIVE-only fields: omitted on a FAILED probe so they stay untouched (no self-assign).
      ...(live ? { lastLiveAt: sql`now()`, active: true } : {}),
    })
    .where(inArray(companies.id, companyIds));
}

/**
 * Advance ONLY `last_probed_at` (+ `updated_at`), without touching the failure streak,
 * `last_live_at`, or `active` — the "probed but couldn't conclude" stamp for an INDETERMINATE or
 * transient reprobe. Without it such a row never advances `last_probed_at` and stays at the head of
 * the oldest-probed-first reprobe queue forever, starving every row behind it. A definitive
 * live/absent verdict uses `markProbeResult` instead.
 */
export async function markProbed(db: Db, companyIds: number[]): Promise<void> {
  if (companyIds.length === 0) return;
  await db
    .update(companies)
    .set({ lastProbedAt: sql`now()`, updatedAt: sql`now()` })
    .where(inArray(companies.id, companyIds));
}

/**
 * Deactivate every company that failed a probe and has shown no sign of life for `olderThanDays`
 * days, decidable from each row alone: ACTIVE, a non-zero failure streak, and a staleness clock
 * COALESCE(GREATEST(last_live_at, last_ingested_at), created_at) older than the window (GREATEST
 * ignores NULLs). A successful ingest counts as liveness: a board is reprobed only every
 * few weeks, so its last LIVE probe alone is often already past the window, and one 404 would
 * deactivate a board that ingests fine (and close all its jobs). A never-failed row (streak 0) is
 * untouched, so a source whose absence can't be asserted — SmartRecruiters' ambiguous 200, which never
 * increments the streak — never wrongly deactivates. Not readily reversible: only a live probe, or a
 * CLI ingest that lists postings, reactivates (`markProbeResult`), and discovery probes an inactive
 * row only when a seed lane re-emits its slug.
 * `opts.source` scopes the sweep to one source so a `--source` run doesn't deactivate rows of an
 * unrelated source it never re-probed; omit it (the broader pass) to sweep all sources. Returns the
 * ids of the rows flipped. `days` is the trunc of an in-code number, never user input.
 */
export async function deactivateStale(
  db: Db,
  olderThanDays = 30,
  opts: { source?: SourceName } = {},
): Promise<number[]> {
  const days = Math.trunc(olderThanDays);
  const conditions = [
    sql`${companies.active} = true`,
    sql`${companies.consecutiveProbeFailures} > 0`,
    sql`COALESCE(GREATEST(${companies.lastLiveAt}, ${companies.lastIngestedAt}), ${companies.createdAt})
      < now() - ${days} * interval '1 day'`,
  ];
  if (opts.source) conditions.push(eq(companies.source, opts.source));
  const rows = await db
    .update(companies)
    .set({ active: false, updatedAt: sql`now()` })
    .where(and(...conditions))
    .returning({ id: companies.id });

  return rows.map((r) => r.id);
}
