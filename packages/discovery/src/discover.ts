import type { Db } from "@opusfinder/db";
import {
  closeJobsForCompanies,
  deactivateStale,
  finishRun,
  listCompaniesForReprobe,
  listCompanyStates,
  markProbeResult,
  markProbed,
  startRun,
  upsertCompany,
} from "@opusfinder/db/repos";
import type { SourceName } from "@opusfinder/shared";

import { probeCandidates, type ProbeOptions } from "./probe";
import { resolveSeed, type ResolveCounts } from "./resolve";
import { SEED_LANES, type CompanyRecord, type SeedLane } from "./seed";
import type { Candidate, ProbeResult } from "./types";

const DEFAULT_OLDER_THAN_DAYS = 30;
const DEFAULT_REPROBE_LIMIT = 500;

export interface DiscoveryOptions {
  /** Scope to one source (omit = all covered sources — the broader default pass). */
  source?: SourceName;
  /**
   * Cap the NEW/INACTIVE-candidate probe worklist (omit = no cap — probe every resolved candidate).
   * A fixed seed-ordered PREFIX slice, NOT a cursor: repeated capped runs re-probe the same head
   * (live candidates reactivate and drop out, so progress is throttled, not zero). For ad-hoc/test
   * runs — the broad pass is uncapped.
   */
  limit?: number;
  /** Preview only: probe + classify + tally, but write NOTHING (no upsert, reprobe, sweep, or run row). */
  dryRun?: boolean;
  /** Staleness window in days (default 30). */
  olderThanDays?: number;
  /** Max ACTIVE companies the reprobe pass re-checks per run (default 500). */
  reprobeLimit?: number;
  /** Prober tuning (concurrency / spacing / retries) — passed through to probeCandidates. */
  probe?: ProbeOptions;
  /** Restrict to these lane names (omit = every registered lane). CLI: `--lanes=hn,outscal`. */
  lanes?: string[];
  /** Worker filter: when true, run only `workerSafe` (fetch-only, bundle-safe) lanes. */
  workerOnly?: boolean;
  /**
   * Board-death close enforcement. Default false = SHADOW (tally `wouldCloseOnDeactivation`, write no
   * `'closed'`); true enforces the close. The Worker sets it via `parseEnforceFlag(env.LIFECYCLE_CLOSE_ENFORCE)`.
   */
  enforceLifecycle?: boolean;
}

/**
 * Flat metric bag, persisted verbatim to `source_runs.counts`. The index signature keeps it
 * assignable to the db `RunCounts` (Record<string, number>) while the named fields give typed access.
 */
export interface DiscoveryCounts {
  [key: string]: number;
  seedRecords: number;
  atsLinks: number;
  badUrl: number;
  deferredNoAdapter: number;
  invalidSlug: number;
  candidates: number;
  alreadyActive: number;
  probeWorklist: number;
  // NEW/INACTIVE worklist pass ONLY (written by tally + probeAndUpsert). These do NOT include
  // reprobe outcomes — a network-exhausted REPROBE lands in reprobeInconclusive below, not in
  // transientFailed — so read these as worklist-pass figures, not run-wide totals.
  probed: number;
  live: number;
  liveEmpty: number;
  absent: number;
  indeterminate: number;
  transientFailed: number;
  upserted: number;
  // ACTIVE-company reprobe pass ONLY — its own buckets, kept separate from the worklist tallies above.
  reprobed: number;
  refreshedLive: number;
  markedFailed: number;
  reprobeInconclusive: number;
  deactivated: number;
  // Board-death close: count-only/shadow → wouldCloseOnDeactivation; enforce writes closed.
  jobsClosedOnDeactivation: number; // active jobs of deactivated boards flipped to 'closed' (enforce; 0 in shadow)
  wouldCloseOnDeactivation: number; // active jobs of deactivated boards that WOULD close (shadow; 0 in enforce)
}

/**
 * The slug-discovery pipeline: seed → resolve → partition → probe NEW/INACTIVE → upsert the live subset
 * → reprobe ACTIVE companies → deactivate the stale ones, all under one `source_runs` row. `db` is
 * injected and there is no argv read, so the Worker calls this directly. The PARTITION fixes the
 * reactivation lock-out: a candidate that is KNOWN-but-INACTIVE joins the probe path (not skipped as
 * "already seen"), so a live probe reactivates it via markProbeResult; only KNOWN-and-ACTIVE rows are
 * left to the reprobe pass. `dryRun` is a pure read-only preview — it writes nothing (no run row,
 * upsert, reprobe, or sweep) but still probes + tallies what it WOULD do.
 */
export async function runDiscovery(db: Db, opts: DiscoveryOptions = {}): Promise<DiscoveryCounts> {
  const dryRun = opts.dryRun ?? false;
  // Coerce a non-positive window to the default: a 0/negative `olderThanDays` makes deactivateStale
  // sweep EVERY failing row (COALESCE(...) < now() - 0), which a plain `?? DEFAULT` would not catch.
  const olderThanDays =
    opts.olderThanDays !== undefined && opts.olderThanDays > 0
      ? opts.olderThanDays
      : DEFAULT_OLDER_THAN_DAYS;
  const counts = emptyCounts();

  const runId = dryRun ? null : await startRun(db, "discovery", { source: opts.source });
  try {
    // 1. SEED + 2. RESOLVE — per lane (the SEED_LANES registry), cross-lane-deduped, per-lane isolated +
    // counted. resolveLanes mutates `counts` (drop tallies + lane_<name>_candidates/_error + candidates).
    const lanes = selectLanes(SEED_LANES, opts);
    if (lanes.length === 0) {
      // opts.lanes named only unknown lanes, or workerOnly matched no workerSafe lane — a misconfig the
      // CLI rejects but a programmatic caller may not. Surface it: seed/resolve is a no-op this run
      // (reprobe + sweep still run on existing rows). An empty/omitted opts.lanes means ALL, not zero.
      console.warn(
        "[discovery] no lanes selected (opts.lanes / workerOnly matched none) — skipping seed/resolve.",
      );
    }
    const resolved = { candidates: await resolveLanes(lanes, counts, { source: opts.source }) };

    // 3. PARTITION: NEW or KNOWN-INACTIVE → probe path (a live probe reactivates); KNOWN-ACTIVE → the
    // reprobe pass. Reading `active` (not plain listCompanies) is what closes the reactivation lock-out.
    const states = await listCompanyStates(db, { source: opts.source });
    const activeByKey = new Map(states.map((s) => [keyOf(s.source, s.slug), s.active]));
    const worklist = resolved.candidates.filter(
      (c) => activeByKey.get(keyOf(c.source, c.slug)) !== true,
    );
    counts.alreadyActive = resolved.candidates.length - worklist.length;
    const scoped = opts.limit !== undefined ? worklist.slice(0, opts.limit) : worklist;
    counts.probeWorklist = scoped.length;

    // PROBE the worklist + ACT; returns the upserted ids so the reprobe pass can skip them.
    const upsertedIds = await probeAndUpsert(db, scoped, counts, dryRun, opts.probe);

    // 7. REPROBE ACTIVE companies + 8. STALENESS SWEEP (writes — skipped on dry-run). The sweep is
    // scoped to opts.source so a --source run can't deactivate rows of a source it never re-probed.
    if (!dryRun) {
      await reprobeActive(
        db,
        opts.source,
        opts.reprobeLimit ?? DEFAULT_REPROBE_LIMIT,
        counts,
        opts.probe,
        upsertedIds,
      );
      const deactivatedIds = await deactivateStale(db, olderThanDays, { source: opts.source });
      counts.deactivated = deactivatedIds.length;
      // Soft-close every still-active job of a just-deactivated (board-death) company — the reprobe path
      // can't see them (activeOnly:true never re-fetches a dead board). Default count-only/shadow (tally
      // wouldCloseOnDeactivation, write no 'closed'); enforcement rides opts.enforceLifecycle.
      const boardClose = await closeJobsForCompanies(db, deactivatedIds, {
        enforce: opts.enforceLifecycle ?? false,
      });
      counts.jobsClosedOnDeactivation = boardClose.closed;
      counts.wouldCloseOnDeactivation = boardClose.wouldClose;
    }

    if (runId !== null) await finishRun(db, runId, { status: "ok", counts });
    logSummary(counts, dryRun);
    return counts;
  } catch (err) {
    // Truncated, secret-free sample (these are public seed/probe URLs + drizzle messages, never creds).
    const errorSample = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    if (runId !== null) await finishRun(db, runId, { status: "error", counts, errorSample });
    throw err;
  }
}

/**
 * Probe the NEW/INACTIVE worklist; a live/live-empty result upserts the company + marks it live.
 * Returns the company ids it wrote, so the reprobe pass can skip the rows this run just stamped
 * (avoiding a same-run double probe on a bootstrap where every active row was just confirmed live).
 */
async function probeAndUpsert(
  db: Db,
  worklist: Candidate[],
  counts: DiscoveryCounts,
  dryRun: boolean,
  probeOpts: ProbeOptions | undefined,
): Promise<Set<number>> {
  const upsertedIds = new Set<number>();
  if (worklist.length === 0) return upsertedIds;
  const results = await probeCandidates(worklist, probeOpts);
  for (let i = 0; i < worklist.length; i++) {
    const c = worklist[i];
    const r = results[i];
    if (!c || !r) continue;
    counts.probed += 1;
    tally(counts, r);
    if (r.outcome === "live" || r.outcome === "live-empty") {
      if (!dryRun) {
        const id = await upsertCompany(db, c.slug, c.source);
        await markProbeResult(db, id, true); // insert-or-reactivate; stamps last_live_at
        upsertedIds.add(id);
      }
      counts.upserted += 1; // upsert is get-or-create + reactivate, so this is "live-and-written", not strictly new
    }
    // absent ⇒ dropped (a never-seen dead slug never enters companies; an inactive one stays inactive);
    // indeterminate / transient ⇒ no write, left for a later run.
  }
  return upsertedIds;
}

/**
 * Re-probe the oldest-probed ACTIVE companies (minus any this run just upserted): refresh the live
 * ones, age the confirmed-absent ones, and on an inconclusive (indeterminate / transient) probe still
 * advance last_probed_at via markProbed so the row moves DOWN the oldest-first queue instead of
 * staying at its head and starving every row behind it.
 */
async function reprobeActive(
  db: Db,
  source: SourceName | undefined,
  limit: number,
  counts: DiscoveryCounts,
  probeOpts: ProbeOptions | undefined,
  exclude: Set<number>,
): Promise<void> {
  const rows = (await listCompaniesForReprobe(db, { source, limit })).filter(
    (row) => !exclude.has(row.id),
  );
  if (rows.length === 0) return;
  const candidates: Candidate[] = rows.map((row) => ({
    source: row.source,
    slug: row.slug,
    rawSlug: row.slug, // stored slug is already canonical; jobsRequest uses ctx.slug
    sourceUrl: "",
  }));
  const results = await probeCandidates(candidates, probeOpts);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const r = results[i];
    if (!row || !r) continue;
    counts.reprobed += 1;
    if (r.outcome === "live" || r.outcome === "live-empty") {
      await markProbeResult(db, row.id, true);
      counts.refreshedLive += 1;
    } else if (r.outcome === "absent") {
      await markProbeResult(db, row.id, false);
      counts.markedFailed += 1;
    } else {
      await markProbed(db, row.id); // inconclusive: advance the probe cursor, don't drift the streak
      counts.reprobeInconclusive += 1;
    }
  }
}

/** Tally one probe outcome. status 0 (network-exhausted) is `transientFailed`, NOT a real outcome. */
function tally(counts: DiscoveryCounts, r: ProbeResult): void {
  if (r.status === 0) {
    counts.transientFailed += 1;
    return;
  }
  if (r.outcome === "live") counts.live += 1;
  else if (r.outcome === "live-empty") counts.liveEmpty += 1;
  else if (r.outcome === "absent") counts.absent += 1;
  else counts.indeterminate += 1;
}

/**
 * Select which registered lanes a run uses: `opts.lanes` restricts by name (an EMPTY or omitted list = no
 * restriction → every lane; an empty array is NOT "zero lanes"); `opts.workerOnly` keeps only `workerSafe`
 * (fetch-only, bundle-safe) lanes for the Worker. Pure → unit-testable.
 */
export function selectLanes(
  registry: SeedLane[],
  opts: { lanes?: string[]; workerOnly?: boolean },
): SeedLane[] {
  return registry.filter(
    (l) =>
      (opts.lanes && opts.lanes.length > 0 ? opts.lanes.includes(l.name) : true) &&
      (!opts.workerOnly || l.workerSafe),
  );
}

/**
 * Step 1+2 for N lanes: fetch each lane (a `failLoud` lane — the core seed — re-throws to FAIL THE RUN;
 * others isolate the failure as a `lane_<name>_error` tally so one flaky external lane can't zero a run),
 * resolve its records to candidates, accumulate the drop-reason counts field-wise (NOT Object.assign —
 * that clobbers across lanes), and cross-lane-dedupe by (source, slug) — resolveSeed's own `seen` is
 * per-call and the partition only drops already-ACTIVE rows, so two lanes emitting the same pair would
 * otherwise both enter the worklist and double-probe. Mutates `counts` (drop tallies +
 * lane_<name>_candidates/_error + candidates); returns the merged, deduped candidates. Pure of db/probe
 * → unit-testable with stub lanes.
 */
export async function resolveLanes(
  lanes: SeedLane[],
  counts: DiscoveryCounts,
  opts: { source?: SourceName },
): Promise<Candidate[]> {
  const seen = new Set<string>(); // cross-lane key set
  const candidates: Candidate[] = [];
  for (const lane of lanes) {
    let records: CompanyRecord[];
    try {
      records = await lane.fetch();
    } catch (err) {
      // Tally the error, then either FAIL LOUD (a failLoud lane — the core outscal seed — re-throws into
      // runDiscovery's catch → finishRun status:error) or ISOLATE the new external lanes (continue, so
      // one flaky third party can't zero a run). Echo name + message shape only (public URLs / status
      // text, never a body or cred).
      counts[`lane_${lane.name}_error`] = (counts[`lane_${lane.name}_error`] ?? 0) + 1;
      if (lane.failLoud) throw err;
      console.error(
        `[discovery] lane "${lane.name}" fetch failed (isolated): ` +
          (err instanceof Error ? err.message : String(err)).slice(0, 200),
      );
      continue;
    }
    const resolved = resolveSeed(records, { source: opts.source });
    accumulateCounts(counts, resolved.counts);
    let laneNew = 0;
    for (const c of resolved.candidates) {
      const k = keyOf(c.source, c.slug);
      if (seen.has(k)) continue;
      seen.add(k);
      candidates.push(c);
      laneNew += 1;
    }
    counts[`lane_${lane.name}_candidates`] =
      (counts[`lane_${lane.name}_candidates`] ?? 0) + laneNew;
  }
  counts.candidates = candidates.length;
  return candidates;
}

/**
 * Field-wise accumulate a lane's ResolveCounts drop tallies into the run counts bag — a single
 * Object.assign in an N-lane loop would CLOBBER (last-lane-wins) each prior lane's named totals.
 * `candidates` is NOT summed here: it is set once, post cross-lane dedupe, to the merged length
 * (summing would re-count a (source, slug) two lanes both emit).
 */
function accumulateCounts(counts: DiscoveryCounts, r: ResolveCounts): void {
  counts.seedRecords += r.seedRecords;
  counts.atsLinks += r.atsLinks;
  counts.badUrl += r.badUrl;
  counts.deferredNoAdapter += r.deferredNoAdapter;
  counts.invalidSlug += r.invalidSlug;
}

function keyOf(source: SourceName, slug: string): string {
  return JSON.stringify([source, slug]);
}

export function emptyCounts(): DiscoveryCounts {
  return {
    seedRecords: 0,
    atsLinks: 0,
    badUrl: 0,
    deferredNoAdapter: 0,
    invalidSlug: 0,
    candidates: 0,
    alreadyActive: 0,
    probeWorklist: 0,
    probed: 0,
    live: 0,
    liveEmpty: 0,
    absent: 0,
    indeterminate: 0,
    transientFailed: 0,
    upserted: 0,
    reprobed: 0,
    refreshedLive: 0,
    markedFailed: 0,
    reprobeInconclusive: 0,
    deactivated: 0,
    jobsClosedOnDeactivation: 0,
    wouldCloseOnDeactivation: 0,
  };
}

/** One shape-only summary line (counts, never secrets). */
function logSummary(counts: DiscoveryCounts, dryRun: boolean): void {
  const prefix = dryRun ? "[dry-run] " : "";
  console.log(
    `${prefix}Discovery: ${counts.candidates} candidates ` +
      `(${counts.alreadyActive} already-active, ${counts.deferredNoAdapter} no-adapter, ` +
      `${counts.badUrl} bad-url, ${counts.invalidSlug} invalid-slug). ` +
      `Probed ${counts.probed}: live ${counts.live}, empty ${counts.liveEmpty}, absent ${counts.absent}, ` +
      `indet ${counts.indeterminate}, transient ${counts.transientFailed}; upserted ${counts.upserted}, ` +
      `reprobed ${counts.reprobed}, refreshed ${counts.refreshedLive}, marked-failed ${counts.markedFailed}, ` +
      `inconclusive ${counts.reprobeInconclusive}, deactivated ${counts.deactivated} ` +
      `(board-close: ${counts.jobsClosedOnDeactivation} closed, ${counts.wouldCloseOnDeactivation} would-close).`,
  );
}
