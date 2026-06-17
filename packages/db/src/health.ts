import { sql } from "drizzle-orm";

import type { Db } from "./client";
import { resultRows } from "./repos/sql";

/**
 * Pipeline health checker (Phase F6) — "kill silent failure". Health data is recorded across five
 * tables but read by nobody on a schedule; this module is the watcher. It computes seven liveness
 * checks + a cost rollup from EXISTING columns (pure Neon reads, no migration) and returns a
 * shape-only {@link HealthReport} the `pnpm health` CLI prints/alerts on AND a future Phase-12 dev
 * panel renders.
 *
 * DESIGN (the panel foundation, F6 owner decision 2026-06-14): the module is split so the alerting
 * "now" and the panel "later" share ONE core.
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

/** The seven F6 checks (stable ids — the panel + env modes key off these). */
export type HealthCheckId =
  | "ingestion_staleness" // (a) last successful ingestion age
  | "board_fail_ratio" // (b) within-run failed/companies — the status='ok' trap
  | "discovery_window" // (c) discovery last-run age
  | "embedding_backlog" // (d) jobs WHERE embedding IS NULL
  | "digest_health" // (e) any digest_runs with status='error' in the window
  | "bounce_suppression" // (f) hard-bounced / suppressed users
  | "discovery_lane_errors"; // (h) lane_<name>_error tallies on the latest discovery run (F5f)

/** Per-check posture (`[[shadow-validate-tunable-filters]]`): `off` = don't compute; `shadow` =
 *  compute + log but never page (never sets `unhealthy`); `enforce` = a firing check sets `unhealthy`. */
export type HealthMode = "off" | "shadow" | "enforce";

/** Env-tunable numeric thresholds. Defaults seed the watermark; real values are validated on live
 *  traffic in `shadow` before any check is flipped to `enforce`. */
export interface HealthThresholds {
  /** (a) hours since the last `status='ok'` ingestion run before staleness fires. Default 3 = ~3× the
   *  hourly cron period — a single missed tick pushes the next success to ~2h, so 3h tolerates it
   *  without flapping. */
  ingestMaxAgeH: number;
  /** (b) within-run `counts.failed / counts.companies` ratio that fires the board-failure check. */
  failRatio: number;
  /** (c) days since the last successful discovery run before the window fires. Default 13 ≈ ~2× the weekly
   *  Sunday cron period — tolerates a late/jittered run but still fires on a fully missed week (~14d).
   *  (Was 8 while discovery was paused; F5f resumed the weekly cron, so 8d would flap on normal jitter.) */
  discoveryMaxAgeD: number;
  /** (d) un-embedded backlog (`jobs.embedding IS NULL`) watermark. */
  backlogMax: number;
  /** (e) how many most-recent digest runs to scan for a `status='error'` run (clamped to >=1). */
  digestWindowN: number;
  /** Cost rollup window: how many most-recent `digests` rows to sum rerank-cache tokens over. */
  costRollupN: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  ingestMaxAgeH: 3,
  failRatio: 0.5,
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
 *  Rerank-cache tokens only: synthesis (Sonnet) usage is persisted nowhere (`digest.ts`), so total
 *  LLM spend is deferred to `F6-COST` / the dev panel. Reads NAMED keys, tolerating the extra
 *  `digests.counts` keys F2's pre-send probe folds in. */
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
  /** (b) the latest ingestion run's status + `counts.failed` / `counts.companies` (the chunk
   *  denominator). `status` lets the check fire on an errored run that processed 0 boards — which
   *  `failed/companies` alone (a 0/0 → 0 ratio) would read as healthy. */
  latestIngestStatus: string | null;
  latestIngestFailed: number;
  latestIngestCompanies: number;
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
  /** (e) count of recent digest runs with `status='error'` in the window. (Per-user shortfall was
   *  dropped — dispatch != completion AND the digest pipeline legitimately persists no row for
   *  no-candidate / below-quality-floor recipients, so `dispatched > persisted` cannot distinguish a
   *  failure from a normal no-op; delivery failures are caught by (f).) */
  digestErrors: number;
  /** (f) hard-bounced and suppressed user counts. */
  hardBounces: number;
  suppressed: number;
  /** raw cost rollup inputs (summed over recent `digests`). */
  cost: { digestsConsidered: number; rerankCacheReadTokens: number; rerankCacheCreationTokens: number };
}

export interface HealthReport {
  checks: HealthCheck[];
  cost: HealthCost;
  /** `true` iff any `enforce`-mode check is firing. `shadow` firings are logged, never paged. */
  unhealthy: boolean;
}

/** A check that should page: `enforce` mode AND `firing`. The single source of truth for both
 *  `HealthReport.unhealthy` and any consumer (the CLI alert body, the future panel) that re-derives the
 *  firing-enforce list — so the alert can never drift from the report's own verdict. */
export const isEnforceFiring = (c: HealthCheck): boolean => c.mode === "enforce" && c.state === "firing";

const CHECK_LABELS: Record<HealthCheckId, string> = {
  ingestion_staleness: "Ingestion staleness",
  board_fail_ratio: "Board fail-ratio",
  discovery_window: "Discovery window",
  embedding_backlog: "Embedding backlog",
  digest_health: "Digest health",
  bounce_suppression: "Bounce / suppression",
  discovery_lane_errors: "Discovery lane errors",
};

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
  // Clamp to >=1: a 0 (or sub-1) window would issue `LIMIT 0` and SILENTLY disarm the check it sizes
  // (digestErrors → always 0; the cost rollup → empty), even in enforce mode. `?? default` only catches
  // undefined, not a 0 an operator set via HEALTH_DIGEST_WINDOW_N / HEALTH_COST_ROLLUP_N.
  const digestWindowN = Math.max(1, opts?.digestWindowN ?? DEFAULT_HEALTH_THRESHOLDS.digestWindowN);
  const costRollupN = Math.max(1, opts?.costRollupN ?? DEFAULT_HEALTH_THRESHOLDS.costRollupN);

  // Issue all eight independent reads concurrently — each db.execute is a separate neon-http round-trip
  // and none depends on another's result, so Promise.all bounds total latency by the slowest single
  // query (matters for the serverless dev-panel caller under a function time budget), not their sum.
  const [ingestAgeR, latestIngestR, discoveryAgeR, backlogsR, digestErrR, bounceR, costR, discoveryLaneR] =
    await Promise.all([
      // (a) last successful ingestion age (index source_runs_pipeline_started_idx).
      db.execute(sql`
        SELECT extract(epoch FROM (now() - max(finished_at))) / 3600.0 AS age_h
        FROM source_runs WHERE pipeline = 'ingestion' AND status = 'ok'
      `),
      // (b) latest ingestion run's status + fail-ratio inputs. Read `counts`, NOT `status` ALONE (a run
      //     where every board 404'd stays status='ok' while incrementing counts.failed) — but ALSO carry
      //     `status` so an errored run that processed 0 boards (counts.companies=0 → a 0/0 ratio that
      //     would read healthy) still fires. `::numeric` (not `::int`) so a non-integer value can never
      //     abort the query and take the checker dark.
      db.execute(sql`
        SELECT status,
               coalesce((counts->>'failed')::numeric, 0)    AS failed,
               coalesce((counts->>'companies')::numeric, 0) AS companies
        FROM source_runs WHERE pipeline = 'ingestion' ORDER BY started_at DESC LIMIT 1
      `),
      // (c) discovery window — last SUCCESS (finished_at WHERE status='ok'), mirroring (a), so a
      //     crash-looping discovery that keeps STARTING (started_at=now each tick) does not read fresh.
      db.execute(sql`
        SELECT extract(epoch FROM (now() - max(finished_at))) / 86400.0 AS age_d
        FROM source_runs WHERE pipeline = 'discovery' AND status = 'ok'
      `),
      // (d) un-embedded backlog.
      db.execute(sql`
        SELECT count(*) FILTER (WHERE embedding IS NULL) AS embedding_backlog
        FROM jobs
      `),
      // (e) digest health — count error-status runs in the recent window. (Per-user shortfall was
      //     dropped: digest_runs finalizes right after the fire-and-forget dispatch, AND the pipeline
      //     legitimately persists no digests row for no-candidate / below-quality-floor recipients, so
      //     dispatched>persisted cannot distinguish a failure from a normal no-op; (f) catches delivery.)
      db.execute(sql`
        SELECT count(*) FILTER (WHERE status = 'error')::int AS errors
        FROM (SELECT status FROM digest_runs ORDER BY started_at DESC LIMIT ${digestWindowN}) t
      `),
      // (f) bounce / suppression spike.
      db.execute(sql`
        SELECT count(*) FILTER (WHERE digest_bounce_status = 'hard')    AS hard_bounced,
               count(*) FILTER (WHERE digest_suppressed_at IS NOT NULL) AS suppressed
        FROM user_preferences
      `),
      // cost rollup — the NAMED rerank-cache keys over recent digests (counts carries other keys too).
      db.execute(sql`
        SELECT counts FROM digests ORDER BY created_at DESC LIMIT ${costRollupN}
      `),
      // (h) latest discovery run's per-lane error tallies — read its counts bag, sum lane_*_error in JS
      //     (dynamic keys). ANY status: an isolated lane failure leaves the run status='ok', so the age
      //     check (c) can't see it. `source IS NULL` scopes to the unattended all-source weekly sweep (the
      //     cron passes no source), so an ad-hoc `pnpm discover --source=X` run can't shadow it. Newest first.
      db.execute(sql`
        SELECT counts FROM source_runs
        WHERE pipeline = 'discovery' AND source IS NULL ORDER BY started_at DESC LIMIT 1
      `),
    ]);

  const ingestAge = resultRows(ingestAgeR)[0] as { age_h: unknown } | undefined;
  const latestIngest = resultRows(latestIngestR)[0] as
    | { status: unknown; failed: unknown; companies: unknown }
    | undefined;
  const discoveryAge = resultRows(discoveryAgeR)[0] as { age_d: unknown } | undefined;
  const backlogs = resultRows(backlogsR)[0] as
    | { embedding_backlog: unknown }
    | undefined;
  const digestErr = resultRows(digestErrR)[0] as { errors: unknown } | undefined;
  const bounce = resultRows(bounceR)[0] as { hard_bounced: unknown; suppressed: unknown } | undefined;
  const costRows = resultRows(costR) as Array<{ counts: Record<string, unknown> | null }>;

  let rerankCacheReadTokens = 0;
  let rerankCacheCreationTokens = 0;
  for (const r of costRows) {
    rerankCacheReadTokens += num(r.counts?.rerankCacheReadTokens);
    rerankCacheCreationTokens += num(r.counts?.rerankCacheCreationTokens);
  }

  const discoveryCountsRow = resultRows(discoveryLaneR)[0] as
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
    latestIngestCompanies: num(latestIngest?.companies),
    discoveryAgeD: discoveryAge?.age_d == null ? null : num(discoveryAge.age_d),
    discoveryLaneErrors,
    embeddingBacklog: num(backlogs?.embedding_backlog),
    digestErrors: num(digestErr?.errors),
    hardBounces: num(bounce?.hard_bounced),
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
  const t = { ...DEFAULT_HEALTH_THRESHOLDS, ...opts?.thresholds };
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

  const failRatio = signals.latestIngestCompanies > 0 ? signals.latestIngestFailed / signals.latestIngestCompanies : 0;
  const bounceTotal = signals.hardBounces + signals.suppressed;

  const checks: HealthCheck[] = [
    // (a) null age (never succeeded) is itself a failure → firing.
    make(
      "ingestion_staleness",
      signals.ingestionAgeH,
      t.ingestMaxAgeH,
      signals.ingestionAgeH === null || signals.ingestionAgeH > t.ingestMaxAgeH,
    ),
    // (b) fire if the latest run errored outright, OR (when it processed boards) the fail-ratio breaches.
    //     The status arm catches a full-run abort (companies=0 → a 0/0 ratio that would read healthy).
    make(
      "board_fail_ratio",
      failRatio,
      t.failRatio,
      signals.latestIngestStatus === "error" ||
        (signals.latestIngestCompanies > 0 && failRatio > t.failRatio),
    ),
    // (c) null age (no discovery run) → firing.
    make(
      "discovery_window",
      signals.discoveryAgeD,
      t.discoveryMaxAgeD,
      signals.discoveryAgeD === null || signals.discoveryAgeD > t.discoveryMaxAgeD,
    ),
    make("embedding_backlog", signals.embeddingBacklog, t.backlogMax, signals.embeddingBacklog > t.backlogMax),
    // (e)/(f) fire on any occurrence (threshold null = boolean condition).
    make("digest_health", signals.digestErrors, null, signals.digestErrors > 0),
    make("bounce_suppression", bounceTotal, null, bounceTotal > 0),
    // (h) any per-lane discovery fetch error on the latest run (threshold null = boolean, fire on > 0).
    make("discovery_lane_errors", signals.discoveryLaneErrors, null, signals.discoveryLaneErrors > 0),
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
 * Compose the reads + the pure evaluation. PURE of env/console/process — callable verbatim from a
 * Node CLI, a Vercel serverless route (the dev panel), or any neon-http `Db`. Pass `opts` explicitly;
 * use {@link healthOptionsFromEnv} at the call site if you want env-driven thresholds/modes.
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
 * `HEALTH_INGEST_MAX_AGE_H` / `HEALTH_FAIL_RATIO` / `HEALTH_DISCOVERY_MAX_AGE_D` / `HEALTH_BACKLOG_MAX` /
 * `HEALTH_DIGEST_WINDOW_N` / `HEALTH_COST_ROLLUP_N`. Modes (default
 * `shadow`): `HEALTH_ENFORCE` and `HEALTH_OFF` are comma-separated check-id lists.
 */
export function healthOptionsFromEnv(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): HealthOptions {
  const n = (key: string): number | undefined => {
    const v = env[key];
    if (v === undefined || v.trim() === "") return undefined;
    const parsed = Number(v);
    // Reject NaN/Infinity AND negatives: every threshold here is an age/ratio/count/window size that is
    // meaningless below 0, and a negative high-watermark would invert the check (count > -1 ⇒ always
    // fires). An out-of-range value falls through to the default rather than silently mis-arming a check.
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const thresholds: Partial<HealthThresholds> = {
    ingestMaxAgeH: n("HEALTH_INGEST_MAX_AGE_H"),
    failRatio: n("HEALTH_FAIL_RATIO"),
    discoveryMaxAgeD: n("HEALTH_DISCOVERY_MAX_AGE_D"),
    backlogMax: n("HEALTH_BACKLOG_MAX"),
    digestWindowN: n("HEALTH_DIGEST_WINDOW_N"),
    costRollupN: n("HEALTH_COST_ROLLUP_N"),
  };
  // Drop undefined keys so they don't overwrite the defaults in the {...defaults, ...thresholds} merge.
  for (const k of Object.keys(thresholds) as (keyof HealthThresholds)[]) {
    if (thresholds[k] === undefined) delete thresholds[k];
  }

  const ids = new Set<HealthCheckId>(Object.keys(CHECK_LABELS) as HealthCheckId[]);
  const parseList = (key: string): HealthCheckId[] =>
    (env[key] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is HealthCheckId => ids.has(s as HealthCheckId));
  const modes: Partial<Record<HealthCheckId, HealthMode>> = {};
  for (const id of parseList("HEALTH_OFF")) modes[id] = "off";
  for (const id of parseList("HEALTH_ENFORCE")) modes[id] = "enforce"; // enforce wins over off if both list it

  return { thresholds, modes };
}
