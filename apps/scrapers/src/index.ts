import { createDb, type Db } from "@opusfinder/db";
import { describeDbError } from "@opusfinder/db/errors";
import { DEFAULT_STALE_TTL_DAYS, runPrune } from "@opusfinder/db/repos";
import { runDiscovery } from "@opusfinder/discovery";
import { parseEnforceFlag } from "@opusfinder/shared";
import { runIngestion, type IngestionCounts } from "@opusfinder/sources";

import {
  discoverRun,
  errorRun,
  firstLine,
  ingestRun,
  ingestSummary,
  noBoardIngested,
  recordRun,
  shadowGate,
  type ControlBinding,
  type ScrapersStage,
  type TickStart,
} from "./control";

/**
 * The opusfinder scrapers Worker: two scheduled (cron) handlers — ingestion (every 2 h) and discovery
 * (weekly) — dispatched on `controller.cron`. Each builds the neon-http client with
 * `createDb(env.DATABASE_URL)` (fetch-only, no `process.env`) and calls an already-Worker-forward
 * library (`runIngestion` / `runDiscovery`) that owns its own `source_runs` row.
 *
 * The Worker imports ONLY fetch-based libraries — no Node-targeted package enters the bundle — so it
 * needs no `nodejs_compat`. Inline embedding is intentionally NOT wired here: the embeddings package
 * loads its env from disk at import (dotenv, node:url), which `pnpm guard:worker` keeps out of this
 * bundle. Jobs are upserted regardless; the still-NULL vectors are filled by `pnpm embeddings:backfill`.
 *
 * The cron strings below MUST match wrangler.toml [triggers].crons CHARACTER-FOR-CHARACTER — in
 * particular the discovery weekday: Cloudflare numbers weekdays 1=Sun..7=Sat, so it is "SUN", never
 * "0". The handler AWAITS the dispatched PIPELINE work (not fire-and-forget `ctx.waitUntil`) in one
 * try/catch, so a failure in the KV cursor I/O or the pipeline is logged to `wrangler tail` and re-thrown
 * so Cloudflare records the invocation as errored. The `ctx.waitUntil` exceptions are the watchdog pings:
 * the liveness heartbeat ({@link pingWatchdog}, a content-free ping on a SUCCESSFUL tick) and the failure
 * ping ({@link pingWatchdogFail}, a shape-safe cause on a caught exception, or the counts of an ingest
 * tick that ingested no board) — both non-blocking so a watchdog hiccup can never fail the tick — and the
 * control-plane ledger row (below).
 *
 * CONTROL PLANE, IN SHADOW (./control.ts): each tick first reads its stage's gate over the CONTROL service
 * binding (bounded at ~2 s) and logs it — `on`, or `would skip: off …` / `would skip: control plane
 * unreadable …` — plus a line naming the slices its overrides turn off, and one when the gate's knobs or
 * policies differ from what the tick uses (INGEST_LIMIT / the discovery limits, LIFECYCLE_CLOSE_ENFORCE,
 * STALE_SWEEP, STALE_SWEEP_TTL_DAYS).
 * The tick then runs exactly as before whatever the gate said: the env vars and constants still rule. At
 * the end (success, budget stop or throw) it records one ledger row in `ctx.waitUntil`; a control-plane
 * failure is logged and never fails the tick or skips a watchdog ping.
 *
 * GUARD: `pnpm guard:worker` substring-scans this file (comments included, case-sensitive) for the
 * forbidden server-only package imports. The guard does NOT detect a provider/watchdog HOST literal, so by
 * author discipline never write one (or any forbidden package name) anywhere in this file — the ping
 * target lives ONLY in `env.HEALTH_PING_URL` (a secret).
 */
interface Env {
  /** Neon connection string as the limited `scrapers_worker` role (a `wrangler secret`, set by
   *  `pnpm --filter @opusfinder/db run worker-role:setup`). */
  DATABASE_URL: string;
  /** Chunk-cursor store for the chunked-cron ingestion lane (a KV namespace binding). */
  INGEST_CURSOR: KVNamespace;
  /** Boards per ingestion tick (the wall/subrequest budget). Default 250 (see DEFAULT_INGEST_LIMIT). */
  INGEST_LIMIT?: string;
  /** External-watchdog ping URL (a `wrangler secret`) — the liveness heartbeat. OPTIONAL: unset ⇒ skipped
   *  silently (redeploy before the watchdog account exists). See {@link pingWatchdog}. */
  HEALTH_PING_URL?: string;
  /** The discovery lane's own watchdog check (a `wrangler secret`, a weekly check). OPTIONAL: unset ⇒ discovery
   *  sends no heartbeat and a failed discovery tick pings HEALTH_PING_URL's check instead. */
  HEALTH_PING_URL_DISCOVER?: string;
  /** Lifecycle-close enforcement — see {@link parseEnforceFlag}. A wrangler `[vars]` value. Unset /
   *  "shadow" = count-only (the default); "enforce" flips the `'closed'` write on. THIS Worker var drives
   *  the scraper-side closes ONLY; the digest 410-close reads the digest runtime's
   *  `process.env.LIFECYCLE_CLOSE_ENFORCE` independently. Keep BOTH in sync so they enforce together (a partial flip is
   *  harmless but confusing). */
  LIFECYCLE_CLOSE_ENFORCE?: string;
  /** Universal staleness-close enforcement — see {@link parseEnforceFlag}. Its OWN switch, SEPARATE from
   *  LIFECYCLE_CLOSE_ENFORCE: unset / "shadow" = count-only (tally `staleWouldClose`, write nothing — the SHIPPED default
   *  so the would-close population is observed on real traffic first); "enforce" closes active jobs not
   *  re-confirmed within STALE_SWEEP_TTL_DAYS. Keep it separate so flipping it never skips the
   *  shadow-observation window: flip to "enforce" only after `pnpm shadow-closes` shows `staleWouldClose` is
   *  a believable trickle, not a spike. */
  STALE_SWEEP?: string;
  /** Staleness-close TTL in days (the {@link sweepStaleJobs} horizon). Default 21 (see DEFAULT_STALE_TTL_DAYS)
   *  — must exceed the worst-case full-sweep latency or a still-live, not-recently-fetched job false-closes. */
  STALE_SWEEP_TTL_DAYS?: string;
  /** The weekly job prune after discovery — see {@link prunePass}. Unset / "shadow" = count-only (the shipped
   *  default); "enforce" deletes up to PRUNE_MAX_ROWS jobs closed for 30+ days that no digest showed. */
  PRUNE?: string;
  /** The control plane: a service binding to the `opusfinder-control` Worker's `ControlRpc` entrypoint
   *  (wrangler.toml [[services]]). Read in SHADOW — see ./control.ts. OPTIONAL: unbound (e.g. `wrangler dev`
   *  without it) ⇒ every gate logs as unreadable and no run is recorded; the ticks run regardless. */
  CONTROL?: ControlBinding;
}

// Must equal the wrangler.toml cron strings exactly (esp. the weekday — "SUN", not "0"); dispatch.test.ts
// pins all three (toml, these constants, the routing) together.
// Ingestion every 2 h (at :00 of even UTC hours): Neon wakes 12×/day instead of 24, and each wake costs the
// tick PLUS a fixed 5-min autosuspend tail. A bigger chunk per tick (INGEST_LIMIT) keeps each board
// re-fetched nearly as often as the old hourly × 150 — wrangler.toml has the sizing arithmetic.
const INGEST_CRON = "0 */2 * * *";
const DISCOVERY_CRON = "0 3 * * SUN";

// Matches wrangler.toml's INGEST_LIMIT (the fallback when the var is unset or invalid); sized there.
const DEFAULT_INGEST_LIMIT = 250;
// Upper bound: a misconfigured INGEST_LIMIT (e.g. "50000") is clamped so one tick can't blow the
// subrequest/wall budget (~500 boards x up to ~20 subrequests; wrangler.toml [limits] sets the cap).
const MAX_INGEST_LIMIT = 500;
// Per-board posting cap — the real per-invocation budget guard. The ~20-subrequests/board assumption
// above breaks on a mega-board: SmartRecruiters boschgroup (~4.6k postings, each an N+1 hydrate fetch)
// otherwise consumes the whole tick's wall-clock / memory / subrequest budget, the run is killed before
// finishRun, and the KV cursor freezes on that chunk forever (the ~21:00 UTC 2026-06-15 outage). Capping
// per-board hydration bounds all three; a capped board ingests its first N postings and runIngestion
// skips its lifecycle sweep (the rest wait — acceptable for the rare giant board).
const MAX_JOBS_PER_BOARD = 1500;
// Whole-run wall-clock budget, well under Cloudflare's 15-min scheduled-Worker per-invocation limit:
// runIngestion stops starting new boards past this and finishes cleanly, so even a chunk of many medium
// boards can't be killed mid-run. Belt-and-suspenders behind the per-board cap. Discovery gets the same
// budget: no probe starts past it, and one in flight ends within a minute (10 s fetch timeout, retries
// capped by MAX_RETRY_WAIT_MS), leaving minutes for its writes, the sweep and finishRun.
const MAX_RUN_MS = 10 * 60_000;
// Fail fast on rate limits: a retry the host wants us to wait longer than this for throws instead of
// sleeping, and runIngestion skips that ATS's boards until its Retry-After passes. Patient retries spent
// ~90 s per Workable board (3 × the 30 s Retry-After cap) and stalled whole ticks on 2026-10-06. A
// discovery probe ends instead, as indeterminate.
const MAX_RETRY_WAIT_MS = 5_000;
// Per-board time limit: past it no new request starts for that board (a 503 storm on one board's detail
// fetches could otherwise run it past Cloudflare's 15-min limit, killing the tick before finishRun and
// freezing the cursor). Worst-case tick: MAX_RUN_MS is checked before each board starts, so the last board
// starts before 10 min, then runs ≤ 120 s, plus one pending backoff (≤ MAX_RETRY_WAIT_MS + jitter), one
// in-flight fetch timeout (10 s) and its pacing pause (≤ 1 s), plus the control gate read before the run
// clock starts (≤ 2 s, GATE_TIMEOUT_MS in ./control): ≈ 2 + 600 + 120 + 5 + 10 + 1 ≈ 738 s ≈ 12.3 min,
// leaving ~2.7 min for that board's DB writes, the stale sweep and finishRun.
const BOARD_TIME_LIMIT_MS = 120_000;
// The most jobs one weekly prune deletes, so a backlog drains over a few weeks instead of in one long delete.
// ~10 calls of 2,000 rows, well under a minute after discovery's ~3 min.
const PRUNE_MAX_ROWS = 20_000;
// Floor for STALE_SWEEP_TTL_DAYS, the registry's stale_sweep.ttlDays min: a typo like "1" must not put an
// enforcing stale sweep on a one-day close horizon.
const MIN_STALE_TTL_DAYS = 7;
const DISCOVERY_LIMIT = 400;
const DISCOVERY_REPROBE_LIMIT = 500;

export default {
  async scheduled(controller, env, ctx): Promise<void> {
    // Fail fast + clearly on a missing connection string, rather than letting neon throw an opaque
    // connection error on the first query deep inside the pipeline.
    if (!env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set — run `pnpm --filter @opusfinder/db run worker-role:setup` (or add it to .dev.vars).",
      );
    }
    const db = createDb(env.DATABASE_URL);
    // The control plane's view of this tick (./control.ts): SHADOW only, nothing below obeys it.
    const tick: TickStart = { startedMs: Date.now(), gateMode: null };
    let stage: ScrapersStage | undefined;

    try {
      switch (controller.cron) {
        case INGEST_CRON: {
          stage = "ingest";
          const limit = ingestLimit(env);
          const ttlDays = staleTtlDays(env);
          tick.gateMode = await shadowGate(env.CONTROL, stage, {
            boardsPerTick: limit,
            close: policyMode(env.LIFECYCLE_CLOSE_ENFORCE),
            stale_sweep: policyMode(env.STALE_SWEEP),
            "stale_sweep.ttlDays": ttlDays ?? DEFAULT_STALE_TTL_DAYS,
          });
          const counts = await runIngestionTick(db, env, limit, ttlDays);
          // Heartbeat AFTER a successful tick (a thrown tick skips this and is recorded as errored,
          // which the watchdog also surfaces as a missing ping). A tick that ingested no board completed,
          // but it is an outage all the same: it pings the failure instead. Non-blocking — see pingWatchdog.
          if (noBoardIngested(counts)) {
            const summary = ingestSummary(counts);
            pingWatchdogFail(
              env.HEALTH_PING_URL,
              ctx,
              `scheduled(${controller.cron}) ingested no board: ${summary}`,
            );
          } else {
            pingWatchdog(env.HEALTH_PING_URL, ctx);
          }
          recordRun(env.CONTROL, ctx, (end) => ingestRun(tick, end, counts));
          break;
        }
        case DISCOVERY_CRON: {
          stage = "discover";
          tick.gateMode = await shadowGate(env.CONTROL, stage, {
            limit: DISCOVERY_LIMIT,
            reprobeLimit: DISCOVERY_REPROBE_LIMIT,
            close: policyMode(env.LIFECYCLE_CLOSE_ENFORCE),
            prune: policyMode(env.PRUNE),
          });
          // workerOnly: run only workerSafe (fetch-only, bundle-safe) lanes so a future Node-only lane
          // can never execute inside the isolate.
          const counts = await runDiscovery(db, {
            limit: DISCOVERY_LIMIT,
            reprobeLimit: DISCOVERY_REPROBE_LIMIT,
            workerOnly: true,
            enforceLifecycle: parseEnforceFlag(env.LIFECYCLE_CLOSE_ENFORCE),
            maxRunMs: MAX_RUN_MS,
            probe: { maxRetryWaitMs: MAX_RETRY_WAIT_MS },
          });
          pingWatchdog(env.HEALTH_PING_URL_DISCOVER, ctx);
          recordRun(env.CONTROL, ctx, (end) => discoverRun(tick, end, counts));
          await prunePass(db, env.PRUNE);
          break;
        }
        default:
          // A cron fired that no case matches. dispatch.test.ts keeps wrangler.toml and the constants above
          // in sync, so the likely cause is Cloudflare still firing a trigger a cron change replaced (on
          // 2026-10-05 the old string fired for ~18 h while the deployed schedules showed the new one). THROW
          // so it surfaces as a FAILED invocation and a failure ping instead of a silent no-op.
          throw new Error(
            `Unhandled cron "${controller.cron}": if wrangler.toml [triggers].crons matches the constants in ` +
              `src/index.ts, Cloudflare is firing a stale trigger: run \`wrangler triggers deploy\`, then ` +
              `check which cron string fires.`,
          );
      }
    } catch (err) {
      // The KV cursor read/write happens here, OUTSIDE runIngestion's own try/catch, so this is the
      // only place those failures (and any infrastructural throw) are caught. Log for `wrangler tail`,
      // signal the watchdog WITH the cause, then re-throw so the Cloudflare cron event records this
      // invocation as errored.
      // Name + describeDbError: a failed query (e.g. finishRun's write on a full disk) reads as its
      // Postgres reason first, redacted, with no `params:` line, in BOTH `wrangler tail` and the watchdog.
      // Any other error keeps its full message here; pingWatchdogFail trims it to the first line for the
      // published surface.
      const detail = err instanceof Error ? `${err.name}: ${describeDbError(err)}` : String(err);
      const message = `scheduled(${controller.cron}) failed: ${detail}`;
      console.error(message);
      // A shape-safe failure ping so the existing watchdog DOWN alert carries WHAT broke and trips
      // IMMEDIATELY (no grace wait). It fires solely when this catch runs, so a dead cron / cold-start kill
      // (no invocation reaching our code) stays detected by ping ABSENCE via {@link pingWatchdog}.
      // Discovery reports to its own check when it has one; otherwise to the ingest check, its only alert.
      const pingUrl =
        stage === "discover"
          ? env.HEALTH_PING_URL_DISCOVER || env.HEALTH_PING_URL
          : env.HEALTH_PING_URL;
      pingWatchdogFail(pingUrl, ctx, message);
      // An unhandled cron has no stage to record against.
      const failed = stage;
      if (failed) recordRun(env.CONTROL, ctx, (end) => errorRun(failed, tick, end, detail));
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Fire-and-forget liveness heartbeat — a content-free ping to an external watchdog (a free
 * dead-man's-switch) on each SUCCESSFUL tick of a stage that has a check (`url`: HEALTH_PING_URL for
 * ingestion, HEALTH_PING_URL_DISCOVER for discovery). The watchdog emails the owner when the pings
 * STOP after its grace window — the ONLY way to detect the cron's OWN death: a paused/dead cron emits
 * nothing, so a co-located checker is silent exactly when the outage happens. Detection is by ping
 * ABSENCE, not a /fail ping.
 *
 * OPTIONAL: unset secret ⇒ skip silently (redeploy before the watchdog account exists). `ctx.waitUntil`
 * so a watchdog hiccup never fails the tick (see {@link sendPing}).
 * GUARD (author discipline — the import-scan guard won't catch a host literal): the target lives ONLY
 * in the `HEALTH_PING_URL*` secrets; keep every provider/watchdog host literal out of this file.
 */
function pingWatchdog(url: string | undefined, ctx: ExecutionContext): void {
  if (!url) return;
  ctx.waitUntil(sendPing("heartbeat", () => fetch(url)));
}

/**
 * Fire-and-forget FAILURE ping — POST a shape-safe cause to the check's `/fail` URL on a caught tick
 * exception (or an ingest tick that ingested no board), so the watchdog's DOWN alert distinguishes
 * errored-vs-vanished and carries the cause (the external watchdog stores a `/fail` POST body, viewable in
 * the check's Events). `/fail` also trips the check DOWN immediately — no grace wait — unlike the
 * absence-detected dead-cron case.
 *
 * SHAPE-SAFE + PUBLISHED: the body lands in an external service, so it is the error name + FIRST LINE
 * only, capped at 500 chars. A failed query arrives already formatted by the caller's describeDbError: its
 * cause's first line (the Postgres reason, which is where a connection string can ride) with URL-like tokens
 * and a keyword-form `password=` redacted, and no `params:` line. First-line-only stays LOAD-BEARING for
 * every other error: a multi-line message (a stack, a wrapped drizzle `params: <array>` line) must not reach
 * the published surface past its first newline.
 *
 * OPTIONAL: unset secret ⇒ skip silently (no network). `ctx.waitUntil` so a watchdog hiccup never fails
 * the tick.
 * GUARD (author discipline): the target lives ONLY in the `HEALTH_PING_URL*` secrets; no provider/watchdog
 * host literal in this file. Exported solely for watchdog.test.ts.
 */
export function pingWatchdogFail(
  url: string | undefined,
  ctx: ExecutionContext,
  message: string,
): void {
  if (!url) return;
  // First line only + capped: drops a multi-line `params:` tail / stack from the published surface.
  const body = firstLine(message, 500);
  ctx.waitUntil(sendPing("failure ping", () => fetch(failUrl(url), { method: "POST", body })));
}

/** The check's `/fail` URL: appended to the ping URL's path, so a trailing slash or a query string can't misroute it. */
function failUrl(pingUrl: string): string {
  const url = new URL(pingUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/fail`;
  return url.href;
}

/**
 * Send one ping and warn when the watchdog didn't take it: no response, an HTTP error, or any reply but a
 * plain "OK" (a check the URL doesn't name can still answer 200). Otherwise a mistyped or rotated secret
 * would turn the alerting off without a trace. Shape only: the URL is the secret, and an error message
 * can carry it. Never throws.
 */
async function sendPing(kind: string, send: () => Promise<Response>): Promise<void> {
  try {
    const res = await send();
    const reply = await res.text();
    if (!res.ok || reply !== "OK") {
      console.warn(
        `watchdog ${kind} not taken: HTTP ${res.status}${reply === "OK" ? "" : ", reply not OK"}`,
      );
    }
  } catch (err) {
    console.warn(
      `watchdog ${kind} not sent (${err instanceof Error ? err.name : "non-Error throw"})`,
    );
  }
}

/**
 * Boards per ingestion tick, from INGEST_LIMIT truncated to an integer. A non-numeric value or one under 1
 * falls back to the default rather than stalling the cron on LIMIT 0 (zero boards every tick) or erroring
 * on LIMIT NaN.
 */
function ingestLimit(env: Env): number {
  const limit = env.INGEST_LIMIT ? Math.trunc(Number(env.INGEST_LIMIT)) : DEFAULT_INGEST_LIMIT;
  return Number.isFinite(limit) && limit >= 1
    ? Math.min(limit, MAX_INGEST_LIMIT)
    : DEFAULT_INGEST_LIMIT;
}

/**
 * Staleness-close TTL in days, from STALE_SWEEP_TTL_DAYS truncated to an integer. A non-numeric value or
 * one under 1 is undefined: sweepStaleJobs then uses its default (DEFAULT_STALE_TTL_DAYS) rather than
 * closing on a NaN/0 horizon. A value below MIN_STALE_TTL_DAYS is raised to it.
 */
function staleTtlDays(env: Env): number | undefined {
  const ttl = Math.trunc(Number(env.STALE_SWEEP_TTL_DAYS));
  return Number.isFinite(ttl) && ttl >= 1 ? Math.max(ttl, MIN_STALE_TTL_DAYS) : undefined;
}

/** A close switch's mode as the control registry names it (`close` / `stale_sweep`: shadow | enforce). */
function policyMode(flag: string | undefined): "shadow" | "enforce" {
  return parseEnforceFlag(flag) ? "enforce" : "shadow";
}

/**
 * The weekly job prune, after discovery (the database is already awake): count the jobs closed for 30+ days
 * that no digest showed and, with PRUNE=enforce, delete up to PRUNE_MAX_ROWS of them. It records its own
 * `prune` source_runs row. Isolated: a failure is logged and recorded there, never failing discovery, which
 * has already pinged its watchdog and recorded its run.
 */
async function prunePass(db: Db, flag: string | undefined): Promise<void> {
  const apply = parseEnforceFlag(flag);
  try {
    const { prunable, deleted } = await runPrune(db, { apply, maxRows: PRUNE_MAX_ROWS });
    const mode = apply ? `on, at most ${PRUNE_MAX_ROWS} a run` : "logs only";
    console.log(`Prune: ${prunable} prunable, ${deleted} deleted (${mode}).`);
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${describeDbError(err)}` : String(err);
    console.error(`prune failed: ${detail}`);
  }
}

/**
 * One ingestion tick: read the chunk cursor from KV, process up to `limit` boards via `runIngestion`
 * (bounded per board by MAX_JOBS_PER_BOARD and per tick by MAX_RUN_MS so a heavy chunk can't be killed
 * before finishRun), then advance or wrap the cursor. Wrap to the start only when the whole chunk ran AND
 * under-filled (`processed >= companies && companies < limit` ⇒ end of table); otherwise advance past the
 * last processed id (continuing a budget-truncated chunk next tick).
 */
async function runIngestionTick(
  db: Db,
  env: Env,
  limit: number,
  ttlDays: number | undefined,
): Promise<IngestionCounts> {
  // A corrupt / non-numeric cursor restarts the sweep from the beginning (afterId 0) rather than
  // stalling on NaN — `WHERE id > NaN` matches nothing, which would loop on empty 0-board ticks.
  const cursorRaw = await env.INGEST_CURSOR.get("afterId");
  const cursorNum = cursorRaw !== null ? Number(cursorRaw) : 0;
  const afterId = Number.isFinite(cursorNum) && cursorNum >= 0 ? Math.trunc(cursorNum) : 0;

  const counts = await runIngestion(db, {
    activeOnly: true,
    afterId,
    limit,
    maxRunMs: MAX_RUN_MS,
    adapter: {
      maxItems: MAX_JOBS_PER_BOARD,
      maxRetryWaitMs: MAX_RETRY_WAIT_MS,
      boardTimeLimitMs: BOARD_TIME_LIMIT_MS,
    },
    enforceLifecycle: parseEnforceFlag(env.LIFECYCLE_CLOSE_ENFORCE),
    // Tier-1 universal staleness sweep — runs EVERY tick (driven by the deployed feature, not gated on the
    // switch) so the would-close population is observed in shadow; `enforce` rides its OWN STALE_SWEEP flag,
    // independent of LIFECYCLE_CLOSE_ENFORCE, so it stays count-only until the owner flips it after reading the counts.
    staleSweep: { ttlDays, enforce: parseEnforceFlag(env.STALE_SWEEP) },
  });

  // Wrap to the start (afterId 0) ONLY when the whole chunk was processed AND it under-filled
  // (companies < limit ⇒ the id-keyset sweep reached the end of the table). If the maxRunMs budget
  // stopped the loop early (processed < companies) there are still boards left in THIS chunk, so advance
  // to the last processed id and continue it next tick — never wrap mid-chunk (that would skip the rest).
  const reachedEnd = counts.processed >= counts.companies && counts.companies < limit;
  const next = reachedEnd ? 0 : counts.lastId;
  await env.INGEST_CURSOR.put("afterId", String(next));
  return counts;
}
