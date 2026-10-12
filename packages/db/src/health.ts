import { sql } from "drizzle-orm";

import type { Db } from "./client";
import { needsEmbeddingSql } from "./repos/embeddings";
import { resultRows } from "./repos/sql";

/**
 * Pipeline health checker — "kill silent failure". Health data is recorded across five tables but
 * read by nobody on a schedule; this module is the watcher. It computes eight liveness checks + a
 * cost rollup from EXISTING columns (pure Neon reads, no migration) and returns a shape-only
 * {@link HealthReport} the `pnpm health` CLI prints/alerts on AND a future dev panel renders.
 *
 * The module is split so the alerting "now" and the panel "later" share ONE core:
 *   - {@link gatherHealthSignals} does the db reads (the only impure part) → raw numbers.
 *   - {@link evaluateHealth} is PURE (no db / env / console / Date / process) → applies thresholds +
 *     `off|shadow|enforce` modes and decides `unhealthy`. This is the logic the smoke test exercises
 *     with canned signals — no db stub needed.
 *   - {@link checkHealth} composes the two: `checkHealth(db, opts?) → HealthReport`.
 *   - {@link healthOptionsFromEnv} maps `HEALTH_*` env → options. It is DELIBERATELY separate from the
 *     pure core (the caller invokes it) so `checkHealth` stays callable verbatim from a serverless
 *     SvelteKit-on-Vercel route on the neon-http client — the dev panel's data path, no new API.
 *
 * No secrets / no PII: every metric is a count / age / ratio; nothing here reads job or user text.
 */

/** The eight checks (stable ids — the panel + env modes key off these). */
export type HealthCheckId =
  | "ingestion_staleness" // last successful ingestion age
  | "board_fail_ratio" // within-run coverage loss: (failed + rateLimitSkipped)/processed — the status='ok' trap
  | "hydrate_skip_ratio" // latest ingestion run: detail fetches that failed / postings on hydrating boards
  | "discovery_window" // discovery last-run age
  | "embedding_backlog" // active jobs still owed a vector (the embed drain's remaining work)
  | "digest_health" // errored digest runs + failed digest sends in the recent window
  | "bounce_suppression" // users suppressed (hard bounce / complaint) in the recent window
  | "discovery_lane_errors"; // lane_<name>_error tallies on the latest discovery run

/** Per-check posture: `off` = don't compute; `shadow` = compute + log but never page (never sets
 *  `unhealthy`); `enforce` = a firing check sets `unhealthy`. */
export type HealthMode = "off" | "shadow" | "enforce";

/** Env-tunable numeric thresholds. Defaults seed the watermark; real values are validated on live
 *  traffic in `shadow` before any check is flipped to `enforce`. */
export interface HealthThresholds {
  /** (a) hours since the last `status='ok'` ingestion run (its finished_at) before staleness fires.
   *  Default 5 = 2.5× the 2-hourly cron period: a healthy age peaks just past 2 h (one period plus the
   *  next tick's run time), a single missed tick pushes it to ~4.2 h — tolerated without flapping — and
   *  two missed ticks (~6.2 h) fire. */
  ingestMaxAgeH: number;
  /** (b) within-run coverage-loss ratio `(counts.failed + counts.rateLimitSkipped) / counts.processed` (the
   *  boards the loop got through, not the chunk size) that fires the board-failure check — once at least
   *  {@link BOARD_FAIL_MIN_COUNT} boards went un-ingested. */
  failRatio: number;
  /** (i) latest ingestion run's `hydrateSkipped / hydrateListed` — the share of postings on HYDRATING boards
   *  (today only SmartRecruiters) whose detail fetch failed or came back empty, so their content wasn't
   *  written. Default 0.2: a healthy tick loses a handful; a fifth means the detail endpoint is degraded
   *  or rate-limiting us — or postings stay listed while their detail is unavailable (they stay open until
   *  delisted) — and those descriptions are going stale. The denominator is hydrating boards only, so
   *  non-hydrating sources can't dilute the signal. */
  hydrateSkipRatio: number;
  /** (c) days since the last successful discovery run before the window fires. Default 13 ≈ ~2× the weekly
   *  Sunday cron period — tolerates a late/jittered run but still fires on a fully missed week (~14d). */
  discoveryMaxAgeD: number;
  /** (d) un-embedded backlog (active jobs still owed a vector) watermark. */
  backlogMax: number;
  /** (e) how many most-recent digest runs (of the last {@link RECENT_DAYS} days) to scan for errors
   *  (clamped to >=1). */
  digestWindowN: number;
  /** Cost rollup window: how many most-recent `digests` rows to sum rerank-cache tokens over. */
  costRollupN: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  ingestMaxAgeH: 5,
  failRatio: 0.5,
  hydrateSkipRatio: 0.2,
  discoveryMaxAgeD: 13,
  backlogMax: 2000,
  digestWindowN: 10,
  costRollupN: 20,
};

export interface HealthOptions {
  /** Override any subset of {@link DEFAULT_HEALTH_THRESHOLDS}. */
  thresholds?: Partial<HealthThresholds>;
  /** Per-check mode override; any check unset defaults to `shadow` (shadow-first). */
  modes?: Partial<Record<HealthCheckId, HealthMode>>;
}

/** One evaluated check — shape-only (metric is a count / age / ratio, never job/user text). */
export interface HealthCheck {
  id: HealthCheckId;
  /** Short human label for the CLI / panel. */
  label: string;
  /** `firing` = condition breached; `ok` = within bounds; `skipped` = mode `off`. */
  state: "ok" | "firing" | "skipped";
  /** The observed value (age h / ratio / count). `null` = no data to compute (e.g. no successful
   *  ingestion run yet — treated as firing for the age checks). */
  metric: number | null;
  /** The bound the metric is tested against; `null` for boolean conditions (e/f fire on any > 0). */
  threshold: number | null;
  mode: HealthMode;
}

/** Cost rollup — a read-only trend, NOT an alert in v1 (digest volume is too thin to threshold).
 *  Rerank-cache tokens only: synthesis (Sonnet) usage is persisted nowhere, so total LLM spend is
 *  deferred to the dev panel. Reads only the NAMED rerank-cache keys, tolerating the extra
 *  `digests.counts` keys the pre-send probe folds in. */
export interface HealthCost {
  /** How many recent `digests` rows the rollup summed (≤ `costRollupN`). */
  digestsConsidered: number;
  rerankCacheReadTokens: number;
  rerankCacheCreationTokens: number;
  /** read / (read + creation); `null` when both are 0 (no rerank traffic yet). */
  rerankCacheHitRate: number | null;
}

/** Raw signals read from Neon — the impure boundary; everything downstream is pure. */
export interface HealthSignals {
  /** (a) hours since the last `status='ok'` ingestion run; `null` if none ever succeeded. */
  ingestionAgeH: number | null;
  /** (b) the latest FINISHED ingestion run's status + its boards NOT ingested — `counts.failed` plus
   *  `counts.rateLimitSkipped` (left unfetched by a rate-limit cooldown) — over `counts.processed` (the boards
   *  the loop got through: ok, failed or skipped), falling back to `counts.companies` (the chunk size) when
   *  `processed` is absent/0. Divide by processed — not companies — to keep the ratio exact on a
   *  budget-truncated tick (`processed < companies`), where dividing by companies dilutes it. `status` also
   *  lets the check fire on an errored run that got through 0 boards (a 0/0 ratio would read as healthy). */
  latestIngestStatus: string | null;
  latestIngestFailed: number;
  latestIngestRateLimitSkipped: number;
  latestIngestProcessed: number;
  latestIngestCompanies: number;
  /** (i) the latest ingestion run's `counts.hydrateSkipped` (postings whose detail fetch failed) and
   *  `counts.hydrateListed` (postings listed by HYDRATING boards). 0 when absent (an older run row without
   *  the keys). */
  latestIngestHydrateSkipped: number;
  latestIngestHydrateListed: number;
  /** (c) days since the last `status='ok'` discovery run; `null` if none ever succeeded. Like (a),
   *  this is last-SUCCESS (finished_at), not last-attempt — a crash-looping discovery that keeps
   *  starting must not read fresh. */
  discoveryAgeD: number | null;
  /** (h) sum of `lane_<name>_error` tallies on the latest all-source (source IS NULL) discovery run (any
   *  status) — per-lane fetch failures the (c) age check can't see (an isolated lane fails while the run
   *  still finishes status='ok'). 0 when no all-source discovery run exists yet. */
  discoveryLaneErrors: number;
  /** (d) un-embedded backlog. */
  embeddingBacklog: number;
  /** (e) errored runs in the recent window plus failed sends (`digests.delivery_status='failed'`) from those
   *  runs. A run row finishes 'ok' at fan-out, so a per-user failure shows only on its `digests` row; one
   *  that throws before persist leaves no row and is visible only in Inngest. */
  digestErrors: number;
  /** (f) users suppressed in the last {@link RECENT_DAYS} days. A hard bounce and a spam complaint both stamp
   *  `digest_suppressed_at`, so each user counts once. */
  suppressed: number;
  /** raw cost rollup inputs (summed over recent `digests`). */
  cost: {
    digestsConsidered: number;
    rerankCacheReadTokens: number;
    rerankCacheCreationTokens: number;
  };
}

export interface HealthReport {
  checks: HealthCheck[];
  cost: HealthCost;
  /** `true` iff any `enforce`-mode check is firing. `shadow` firings are logged, never paged. */
  unhealthy: boolean;
}

/** A check that should page: `enforce` mode AND `firing`. Single source of truth so the alert can
 *  never drift from the report's own verdict. */
export const isEnforceFiring = (c: HealthCheck): boolean =>
  c.mode === "enforce" && c.state === "firing";

/** The names the alert emails and `pnpm health` use: the same as the control panel's (a sync test pins them). */
const CHECK_LABELS: Record<HealthCheckId, string> = {
  ingestion_staleness: "Ingestion staleness",
  board_fail_ratio: "Board failures",
  hydrate_skip_ratio: "Job detail failures",
  discovery_window: "Discovery staleness",
  embedding_backlog: "Embedding backlog",
  digest_health: "Digest errors",
  bounce_suppression: "Email bounces",
  discovery_lane_errors: "Discovery lane errors",
};

/** board_fail_ratio fires only once at least this many boards went un-ingested (failed + rate-limit-skipped):
 *  a dead board or two in a tiny run reads as a big ratio (2 of 3 = 67%) but isn't an outage, while a
 *  budget-cut run where all 17 boards failed (the 2026-10-06 shape) must still fire. */
export const BOARD_FAIL_MIN_COUNT = 5;

/** (e) and (f) look back this many days, so a one-off failure stops firing once it ages out instead of
 *  latching the check on (nothing ever clears a suppression). */
const RECENT_DAYS = 7;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Read every health signal from Neon in a handful of indexed queries. The ONLY impure function here.
 * Ages are computed SQL-side (`now() - max(...)`) so the pure evaluator needs no clock.
 */
export async function gatherHealthSignals(
  db: Db,
  opts?: { digestWindowN?: number; costRollupN?: number },
): Promise<HealthSignals> {
  // Whole numbers >=1: a 0 (or sub-1) window would issue `LIMIT 0` and SILENTLY disarm the check it sizes
  // (digestErrors → always 0; the cost rollup → empty), even in enforce mode, and a fraction fails the
  // LIMIT's bigint parse, which rejects the Promise.all below and takes every check dark. `?? default` only
  // catches undefined, not what an operator set via HEALTH_DIGEST_WINDOW_N / HEALTH_COST_ROLLUP_N.
  const digestWindowN = Math.max(
    1,
    Math.floor(opts?.digestWindowN ?? DEFAULT_HEALTH_THRESHOLDS.digestWindowN),
  );
  const costRollupN = Math.max(
    1,
    Math.floor(opts?.costRollupN ?? DEFAULT_HEALTH_THRESHOLDS.costRollupN),
  );

  // Issue all reads concurrently so total latency is bounded by the slowest query, not their sum
  // (matters for the serverless dev-panel caller under a function time budget).
  const [
    ingestAgeResult,
    latestIngestResult,
    discoveryAgeResult,
    backlogResult,
    digestErrorResult,
    bounceResult,
    costResult,
    discoveryLaneResult,
  ] = await Promise.all([
    // (a) last successful ingestion age (index source_runs_pipeline_started_idx).
    db.execute(sql`
        SELECT extract(epoch FROM (now() - max(finished_at))) / 3600.0 AS age_h
        FROM source_runs WHERE pipeline = 'ingestion' AND status = 'ok'
      `),
    // (b) + (i) latest FINISHED ingestion run's status, fail-ratio inputs (see latestIngestStatus) and
    //     hydrate-skip inputs — one row, no extra query. A `running` row is skipped: its counts are still the
    //     `{}` default, so reading it would score an in-flight tick as a healthy 0 — and the health cron
    //     fires at :10, inside a tick that runs long. (A zombie running row is terminalized `error` by the
    //     next startRun's failStaleRuns, and then counts.) `::numeric` (not `::int`) so a non-integer value
    //     can never abort the query and take the checker dark.
    db.execute(sql`
        SELECT status,
               coalesce((counts->>'failed')::numeric, 0)          AS failed,
               coalesce((counts->>'rateLimitSkipped')::numeric, 0) AS rate_limit_skipped,
               coalesce((counts->>'processed')::numeric, 0)       AS processed,
               coalesce((counts->>'companies')::numeric, 0)       AS companies,
               coalesce((counts->>'hydrateSkipped')::numeric, 0)  AS hydrate_skipped,
               coalesce((counts->>'hydrateListed')::numeric, 0)   AS hydrate_listed
        FROM source_runs WHERE pipeline = 'ingestion' AND status <> 'running'
        ORDER BY started_at DESC LIMIT 1
      `),
    // (c) discovery window — last SUCCESS (finished_at WHERE status='ok'), mirroring (a), of the all-source
    //     sweep only, as (h): a fresh ad-hoc `pnpm discover --source=X` run must not hide a dead weekly cron.
    db.execute(sql`
        SELECT extract(epoch FROM (now() - max(finished_at))) / 86400.0 AS age_d
        FROM source_runs WHERE pipeline = 'discovery' AND status = 'ok' AND source IS NULL
      `),
    // (d) un-embedded backlog — the drain's own predicate, served by the partial jobs_unembedded_idx.
    db.execute(sql`SELECT count(*) AS embedding_backlog FROM jobs WHERE ${needsEmbeddingSql}`),
    // (e) digest health — errored runs in the recent window, plus the failed sends of those runs.
    db.execute(sql`
        WITH recent AS (
          SELECT id, status FROM digest_runs
          WHERE started_at > now() - ${RECENT_DAYS} * interval '1 day'
          ORDER BY started_at DESC LIMIT ${digestWindowN}
        )
        SELECT ((SELECT count(*) FROM recent WHERE status = 'error')
              + (SELECT count(*) FROM digests
                 WHERE delivery_status = 'failed' AND digest_run_id IN (SELECT id FROM recent)))::int AS errors
      `),
    // (f) recent suppressions.
    db.execute(sql`
        SELECT count(*) AS suppressed FROM user_preferences
        WHERE digest_suppressed_at > now() - ${RECENT_DAYS} * interval '1 day'
      `),
    // cost rollup — the NAMED rerank-cache keys over recent digests (counts carries other keys too).
    db.execute(sql`
        SELECT counts FROM digests ORDER BY created_at DESC LIMIT ${costRollupN}
      `),
    // (h) latest discovery run's per-lane error tallies — sum lane_*_error in JS (dynamic keys).
    //     `source IS NULL` scopes to the all-source weekly sweep so an ad-hoc `pnpm discover --source=X`
    //     run can't shadow it.
    db.execute(sql`
        SELECT counts FROM source_runs
        WHERE pipeline = 'discovery' AND source IS NULL ORDER BY started_at DESC LIMIT 1
      `),
  ]);

  const ingestAge = resultRows(ingestAgeResult)[0] as { age_h: unknown } | undefined;
  const latestIngest = resultRows(latestIngestResult)[0] as
    | {
        status: unknown;
        failed: unknown;
        rate_limit_skipped: unknown;
        processed: unknown;
        companies: unknown;
        hydrate_skipped: unknown;
        hydrate_listed: unknown;
      }
    | undefined;
  const discoveryAge = resultRows(discoveryAgeResult)[0] as { age_d: unknown } | undefined;
  const backlogs = resultRows(backlogResult)[0] as { embedding_backlog: unknown } | undefined;
  const digestErr = resultRows(digestErrorResult)[0] as { errors: unknown } | undefined;
  const bounce = resultRows(bounceResult)[0] as { suppressed: unknown } | undefined;
  const costRows = resultRows(costResult) as Array<{ counts: Record<string, unknown> | null }>;

  let rerankCacheReadTokens = 0;
  let rerankCacheCreationTokens = 0;
  for (const r of costRows) {
    rerankCacheReadTokens += num(r.counts?.rerankCacheReadTokens);
    rerankCacheCreationTokens += num(r.counts?.rerankCacheCreationTokens);
  }

  const discoveryCountsRow = resultRows(discoveryLaneResult)[0] as
    | { counts: Record<string, unknown> | null }
    | undefined;
  let discoveryLaneErrors = 0;
  for (const [k, v] of Object.entries(discoveryCountsRow?.counts ?? {})) {
    if (k.startsWith("lane_") && k.endsWith("_error")) discoveryLaneErrors += num(v);
  }

  return {
    ingestionAgeH: ingestAge?.age_h == null ? null : num(ingestAge.age_h),
    latestIngestStatus: (latestIngest?.status as string | null | undefined) ?? null,
    latestIngestFailed: num(latestIngest?.failed),
    latestIngestRateLimitSkipped: num(latestIngest?.rate_limit_skipped),
    latestIngestProcessed: num(latestIngest?.processed),
    latestIngestCompanies: num(latestIngest?.companies),
    latestIngestHydrateSkipped: num(latestIngest?.hydrate_skipped),
    latestIngestHydrateListed: num(latestIngest?.hydrate_listed),
    discoveryAgeD: discoveryAge?.age_d == null ? null : num(discoveryAge.age_d),
    discoveryLaneErrors,
    embeddingBacklog: num(backlogs?.embedding_backlog),
    digestErrors: num(digestErr?.errors),
    suppressed: num(bounce?.suppressed),
    cost: { digestsConsidered: costRows.length, rerankCacheReadTokens, rerankCacheCreationTokens },
  };
}

/**
 * PURE evaluator: turn raw signals + options into a {@link HealthReport}. No db / env / console /
 * Date / process — the smoke test feeds canned signals here directly. `unhealthy` is true iff any
 * `enforce`-mode check fires; `shadow` firings are reported but never set it.
 */
export function evaluateHealth(signals: HealthSignals, opts?: HealthOptions): HealthReport {
  const thresholds = { ...DEFAULT_HEALTH_THRESHOLDS, ...opts?.thresholds };
  const modes = opts?.modes;

  const make = (
    id: HealthCheckId,
    metric: number | null,
    threshold: number | null,
    breached: boolean,
  ): HealthCheck => {
    const mode = modes?.[id] ?? "shadow";
    const state: HealthCheck["state"] = mode === "off" ? "skipped" : breached ? "firing" : "ok";
    return { id, label: CHECK_LABELS[id], state, metric, threshold, mode };
  };

  // Divide by boards attempted (processed), falling back to companies when processed is 0/absent so the
  // check never goes dark (see latestIngestStatus for the budget-truncated-tick rationale).
  const failDenom =
    signals.latestIngestProcessed > 0
      ? signals.latestIngestProcessed
      : signals.latestIngestCompanies;
  const notIngested = signals.latestIngestFailed + signals.latestIngestRateLimitSkipped;
  const failRatio = failDenom > 0 ? notIngested / failDenom : 0;
  const hydrateListed = signals.latestIngestHydrateListed;
  const hydrateSkipRatio =
    hydrateListed > 0 ? signals.latestIngestHydrateSkipped / hydrateListed : 0;

  const checks: HealthCheck[] = [
    // (a) null age (never succeeded) is itself a failure → firing.
    make(
      "ingestion_staleness",
      signals.ingestionAgeH,
      thresholds.ingestMaxAgeH,
      signals.ingestionAgeH === null || signals.ingestionAgeH > thresholds.ingestMaxAgeH,
    ),
    // (b) fire if the latest run errored outright, OR enough boards went un-ingested AND the ratio breaches.
    //     The status arm catches a full-run abort (processed=0 → a 0/0 ratio that would read healthy).
    make(
      "board_fail_ratio",
      failRatio,
      thresholds.failRatio,
      signals.latestIngestStatus === "error" ||
        (notIngested >= BOARD_FAIL_MIN_COUNT && failRatio > thresholds.failRatio),
    ),
    // (i) fire when the hydrating boards' failed-detail share breaches the threshold. No hydrating posting
    //     listed (0 denominator — e.g. the tick's chunk had no SmartRecruiters board) reads ok, metric 0.
    make(
      "hydrate_skip_ratio",
      hydrateSkipRatio,
      thresholds.hydrateSkipRatio,
      hydrateListed > 0 && hydrateSkipRatio > thresholds.hydrateSkipRatio,
    ),
    // (c) null age (no discovery run) → firing.
    make(
      "discovery_window",
      signals.discoveryAgeD,
      thresholds.discoveryMaxAgeD,
      signals.discoveryAgeD === null || signals.discoveryAgeD > thresholds.discoveryMaxAgeD,
    ),
    make(
      "embedding_backlog",
      signals.embeddingBacklog,
      thresholds.backlogMax,
      signals.embeddingBacklog > thresholds.backlogMax,
    ),
    // (e)/(f) fire on any occurrence (threshold null = boolean condition).
    make("digest_health", signals.digestErrors, null, signals.digestErrors > 0),
    make("bounce_suppression", signals.suppressed, null, signals.suppressed > 0),
    // (h) any per-lane discovery fetch error on the latest run (threshold null = boolean, fire on > 0).
    make(
      "discovery_lane_errors",
      signals.discoveryLaneErrors,
      null,
      signals.discoveryLaneErrors > 0,
    ),
  ];

  const { rerankCacheReadTokens, rerankCacheCreationTokens } = signals.cost;
  const totalRerank = rerankCacheReadTokens + rerankCacheCreationTokens;
  const cost: HealthCost = {
    digestsConsidered: signals.cost.digestsConsidered,
    rerankCacheReadTokens,
    rerankCacheCreationTokens,
    rerankCacheHitRate: totalRerank > 0 ? rerankCacheReadTokens / totalRerank : null,
  };

  const unhealthy = checks.some(isEnforceFiring);
  return { checks, cost, unhealthy };
}

/**
 * Compose the reads + the pure evaluation. Pass `opts` explicitly; use {@link healthOptionsFromEnv} at
 * the call site if you want env-driven thresholds/modes.
 */
export async function checkHealth(db: Db, opts?: HealthOptions): Promise<HealthReport> {
  const signals = await gatherHealthSignals(db, {
    digestWindowN: opts?.thresholds?.digestWindowN,
    costRollupN: opts?.thresholds?.costRollupN,
  });
  return evaluateHealth(signals, opts);
}

/**
 * Build {@link HealthOptions} from `HEALTH_*` env (kept OUT of the pure core on purpose). Thresholds:
 * `HEALTH_INGEST_MAX_AGE_H` / `HEALTH_FAIL_RATIO` / `HEALTH_HYDRATE_SKIP_RATIO` /
 * `HEALTH_DISCOVERY_MAX_AGE_D` / `HEALTH_BACKLOG_MAX` / `HEALTH_DIGEST_WINDOW_N` / `HEALTH_COST_ROLLUP_N`.
 * Modes (default `shadow`): `HEALTH_ENFORCE` and `HEALTH_OFF` are comma-separated check-id lists.
 */
export function healthOptionsFromEnv(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): HealthOptions {
  const parseEnvNumber = (key: string): number | undefined => {
    const v = env[key];
    if (v === undefined || v.trim() === "") return undefined;
    const parsed = Number(v);
    // Reject NaN/Infinity AND negatives: every threshold here is an age/ratio/count/window size that is
    // meaningless below 0, and a negative high-watermark would invert the check (count > -1 ⇒ always
    // fires). An out-of-range value falls through to the default rather than silently mis-arming a check.
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const thresholds: Partial<HealthThresholds> = {
    ingestMaxAgeH: parseEnvNumber("HEALTH_INGEST_MAX_AGE_H"),
    failRatio: parseEnvNumber("HEALTH_FAIL_RATIO"),
    hydrateSkipRatio: parseEnvNumber("HEALTH_HYDRATE_SKIP_RATIO"),
    discoveryMaxAgeD: parseEnvNumber("HEALTH_DISCOVERY_MAX_AGE_D"),
    backlogMax: parseEnvNumber("HEALTH_BACKLOG_MAX"),
    digestWindowN: parseEnvNumber("HEALTH_DIGEST_WINDOW_N"),
    costRollupN: parseEnvNumber("HEALTH_COST_ROLLUP_N"),
  };
  // Drop undefined keys so they don't overwrite the defaults in the {...defaults, ...thresholds} merge.
  for (const k of Object.keys(thresholds) as (keyof HealthThresholds)[]) {
    if (thresholds[k] === undefined) delete thresholds[k];
  }

  const ids = new Set<HealthCheckId>(Object.keys(CHECK_LABELS) as HealthCheckId[]);
  const unknown: string[] = [];
  const parseList = (key: string): HealthCheckId[] =>
    (env[key] ?? "")
      .toLowerCase()
      .split(",")
      // The control panel names a check `health.<id>`; accept that spelling too.
      .map((s) => s.trim().replace(/^health\./, ""))
      .filter((s): s is HealthCheckId => {
        if (ids.has(s as HealthCheckId)) return true;
        if (s !== "") unknown.push(`${key}: ${s}`);
        return false;
      });
  const modes: Partial<Record<HealthCheckId, HealthMode>> = {};
  for (const id of parseList("HEALTH_OFF")) modes[id] = "off";
  for (const id of parseList("HEALTH_ENFORCE")) modes[id] = "enforce"; // enforce wins over off if both list it
  // An unmatched HEALTH_ENFORCE id leaves its check in shadow, never paging: say so, don't fail open silently.
  if (unknown.length > 0) {
    console.warn(
      `[health] ignoring unknown check id(s) (${unknown.join("; ")}); valid ids: ${[...ids].join(", ")}`,
    );
  }

  return { thresholds, modes };
}
