import { createDb, type Db } from "@opusfinder/db";
import { runDiscovery } from "@opusfinder/discovery";
import { parseEnforceFlag } from "@opusfinder/shared";
import { runIngestion } from "@opusfinder/sources";

/**
 * The opusfinder scrapers Worker: two scheduled (cron) handlers — ingestion (frequent) and discovery
 * (weekly) — dispatched on `controller.cron`. Each builds the neon-http client with
 * `createDb(env.DATABASE_URL)` (fetch-only, no `process.env`) and calls an already-Worker-forward
 * library (`runIngestion` / `runDiscovery`) that owns its own `source_runs` row.
 *
 * The Worker imports ONLY fetch-based libraries — no Node-targeted package enters the bundle — so it
 * needs no `nodejs_compat`. Inline embedding is intentionally NOT wired here: wiring
 * `@opusfinder/embeddings` would drag its dotenv env-module into the Worker (and require nodejs_compat).
 * Jobs are upserted regardless; the still-NULL vectors are filled by `pnpm embeddings:backfill`.
 *
 * The cron strings below MUST match wrangler.toml [triggers].crons CHARACTER-FOR-CHARACTER — in
 * particular the discovery weekday: Cloudflare numbers weekdays 1=Sun..7=Sat, so it is "SUN", never
 * "0". The handler AWAITS the dispatched PIPELINE work (not fire-and-forget `ctx.waitUntil`) in one
 * try/catch, so a failure in the KV cursor I/O or the pipeline is logged to `wrangler tail` and re-thrown
 * so Cloudflare records the invocation as errored. The `ctx.waitUntil` exceptions are the watchdog pings:
 * the liveness heartbeat ({@link pingWatchdog}, a content-free ping on a SUCCESSFUL tick) and the failure
 * ping ({@link pingWatchdogFail}, a shape-safe cause on a caught exception) — both non-blocking so a
 * watchdog hiccup can never fail the tick. GUARD: `pnpm guard:worker` substring-scans this file (comments
 * included, case-sensitive) for the forbidden server-only package imports. The guard does NOT detect a
 * provider/watchdog HOST literal, so by author discipline never write one (or any forbidden package name)
 * anywhere in this file — the ping target lives ONLY in `env.HEALTH_PING_URL` (a secret).
 */
interface Env {
  /** Neon connection string (a `wrangler secret`). */
  DATABASE_URL: string;
  /** Chunk-cursor store for the chunked-cron ingestion lane (a KV namespace binding). */
  INGEST_CURSOR: KVNamespace;
  /** Boards per ingestion tick (the wall/subrequest budget). Default 150. */
  INGEST_LIMIT?: string;
  /** External-watchdog ping URL (a `wrangler secret`) — the liveness heartbeat. OPTIONAL: unset ⇒ skipped
   *  silently (redeploy before the watchdog account exists). See {@link pingWatchdog}. */
  HEALTH_PING_URL?: string;
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
}

// Must equal the wrangler.toml cron strings exactly (esp. the weekday — "SUN", not "0").
const INGEST_CRON = "0 * * * *";
const DISCOVERY_CRON = "0 3 * * SUN";

const DEFAULT_INGEST_LIMIT = 150;
// Upper bound: a misconfigured INGEST_LIMIT (e.g. "50000") is clamped so one tick can't blow the
// subrequest/wall budget (~500 boards x up to ~20 subrequests ~= the Workers Paid 10K cap; §6).
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
// boards can't be killed mid-run. Belt-and-suspenders behind the per-board cap.
const MAX_RUN_MS = 10 * 60_000;
// limit + reprobeLimit sized to the subrequest budget (REQUIRES Workers Paid).
const DISCOVERY_LIMIT = 400;
const DISCOVERY_REPROBE_LIMIT = 500;

export default {
  async scheduled(controller, env, ctx): Promise<void> {
    // Fail fast + clearly on a missing connection string, rather than letting neon throw an opaque
    // connection error on the first query deep inside the pipeline.
    if (!env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set — run `wrangler secret put DATABASE_URL` (or add it to .dev.vars).",
      );
    }
    const db = createDb(env.DATABASE_URL);

    try {
      switch (controller.cron) {
        case INGEST_CRON:
          await runIngestionTick(db, env);
          // Heartbeat AFTER a successful tick (a thrown tick skips this and is recorded as errored,
          // which the watchdog also surfaces as a missing ping). Non-blocking — see pingWatchdog.
          pingWatchdog(env, ctx);
          break;
        case DISCOVERY_CRON:
          // workerOnly: run only workerSafe (fetch-only, bundle-safe) lanes so a future Node-only lane
          // can never execute inside the isolate.
          await runDiscovery(db, {
            limit: DISCOVERY_LIMIT,
            reprobeLimit: DISCOVERY_REPROBE_LIMIT,
            workerOnly: true,
            enforceLifecycle: parseEnforceFlag(env.LIFECYCLE_CLOSE_ENFORCE),
          });
          break;
        default:
          // A cron fired that no case matches — wrangler.toml [triggers].crons and the INGEST_CRON/
          // DISCOVERY_CRON constants above have drifted (most likely on resume). THROW so it surfaces
          // as a FAILED invocation in the CF Cron Events table instead of a silent no-op.
          throw new Error(
            `Unhandled cron "${controller.cron}": wrangler.toml [triggers].crons and the cron ` +
              `constants in src/index.ts must match character-for-character.`,
          );
      }
    } catch (err) {
      // The KV cursor read/write happens here, OUTSIDE runIngestion's own try/catch, so this is the
      // only place those failures (and any infrastructural throw) are caught. Log for `wrangler tail`,
      // signal the watchdog WITH the cause, then re-throw so the Cloudflare cron event records this
      // invocation as errored.
      // Name + message: pingWatchdogFail trims to the first line for the published surface, while
      // `wrangler tail` keeps the full multi-line message below.
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const message = `scheduled(${controller.cron}) failed: ${detail}`;
      console.error(message);
      // A shape-safe failure ping so the existing watchdog DOWN alert carries WHAT broke and trips
      // IMMEDIATELY (no grace wait). It fires solely when this catch runs, so a dead cron / cold-start kill
      // (no invocation reaching our code) stays detected by ping ABSENCE via {@link pingWatchdog}.
      pingWatchdogFail(env, ctx, message);
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Fire-and-forget liveness heartbeat — a content-free ping to an external watchdog (a free
 * dead-man's-switch) on each SUCCESSFUL ingestion tick. The watchdog emails the owner when the pings
 * STOP after its grace window — the ONLY way to detect the cron's OWN death: a paused/dead cron emits
 * nothing, so a co-located checker is silent exactly when the outage happens. Detection is by ping
 * ABSENCE, not a /fail ping.
 *
 * OPTIONAL: unset secret ⇒ skip silently (redeploy before the watchdog account exists). `ctx.waitUntil`
 * so a watchdog hiccup never fails the tick; a default GET whose response body is left unconsumed (the
 * `waitUntil`-bounded promise lets the runtime GC it — no leak).
 * GUARD (author discipline — the import-scan guard won't catch a host literal): the target lives ONLY
 * in `env.HEALTH_PING_URL` (a secret); keep every provider/watchdog host literal out of this file.
 */
function pingWatchdog(env: Env, ctx: ExecutionContext): void {
  if (!env.HEALTH_PING_URL) return;
  ctx.waitUntil(fetch(env.HEALTH_PING_URL).catch(() => {}));
}

/**
 * Fire-and-forget FAILURE ping — POST a shape-safe cause to `${HEALTH_PING_URL}/fail` on a caught tick
 * exception, so the watchdog's DOWN alert distinguishes errored-vs-vanished and carries the cause (the
 * external watchdog stores a `/fail` POST body, viewable in the check's Events). `/fail` also trips the
 * check DOWN immediately — no grace wait — unlike the absence-detected dead-cron case.
 *
 * SHAPE-SAFE + PUBLISHED: the body lands in an external service, so it is the error name + FIRST LINE
 * only, capped at 500 chars — never a connection string (which rides `err.cause`, NOT `err.message`;
 * diagnose Neon failures by cause shape, never the URL). First-line-only is LOAD-BEARING: a drizzle
 * `DrizzleQueryError` message is multi-line (`Failed query: <SQL>` then `params: <array>`), so dropping
 * everything past the first newline keeps the bound-param array off the published surface.
 *
 * OPTIONAL: unset secret ⇒ skip silently (no network). `ctx.waitUntil` so a watchdog hiccup never fails
 * the tick (we are already in the catch; the original error is re-thrown by the caller regardless).
 * GUARD (author discipline): the target lives ONLY in `env.HEALTH_PING_URL`; no provider/watchdog host
 * literal in this file. Exported solely for the `test:watchdog` smoke.
 */
export function pingWatchdogFail(env: Env, ctx: ExecutionContext, message: string): void {
  if (!env.HEALTH_PING_URL) return;
  // First line only + capped: split always yields ≥1 element, so `[0]` is the text before the first
  // newline — which drops a multi-line drizzle `params:` tail / stack from the published surface.
  const body = (message.split("\n")[0] ?? "").slice(0, 500);
  ctx.waitUntil(fetch(`${env.HEALTH_PING_URL}/fail`, { method: "POST", body }).catch(() => {}));
}

/**
 * One ingestion tick: read the chunk cursor from KV, process up to `INGEST_LIMIT` boards via
 * `runIngestion` (bounded per board by MAX_JOBS_PER_BOARD and per tick by MAX_RUN_MS so a heavy chunk
 * can't be killed before finishRun), then advance or wrap the cursor. Wrap to the start only when the
 * whole chunk ran AND under-filled (`processed >= companies && companies < limit` ⇒ end of table);
 * otherwise advance past the last processed id (continuing a budget-truncated chunk next tick).
 */
async function runIngestionTick(db: Db, env: Env): Promise<void> {
  // A corrupt / non-numeric cursor restarts the sweep from the beginning (afterId 0) rather than
  // stalling on NaN — `WHERE id > NaN` matches nothing, which would loop on empty 0-board ticks.
  const cursorRaw = await env.INGEST_CURSOR.get("afterId");
  const cursorNum = cursorRaw !== null ? Number(cursorRaw) : 0;
  const afterId = Number.isFinite(cursorNum) && cursorNum >= 0 ? Math.trunc(cursorNum) : 0;

  // A non-numeric / non-positive INGEST_LIMIT falls back to the default rather than stalling the cron
  // on LIMIT 0 (zero boards every tick) or erroring on LIMIT NaN.
  const limitRaw = env.INGEST_LIMIT ? Number(env.INGEST_LIMIT) : DEFAULT_INGEST_LIMIT;
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.trunc(limitRaw), MAX_INGEST_LIMIT)
      : DEFAULT_INGEST_LIMIT;

  // Tier-1 staleness sweep TTL: a non-numeric / non-positive STALE_SWEEP_TTL_DAYS falls back to the
  // sweepStaleJobs default (DEFAULT_STALE_TTL_DAYS) rather than closing on a NaN/0 horizon.
  const ttlRaw = env.STALE_SWEEP_TTL_DAYS ? Number(env.STALE_SWEEP_TTL_DAYS) : undefined;
  const staleTtlDays =
    ttlRaw !== undefined && Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.trunc(ttlRaw) : undefined;

  const counts = await runIngestion(db, {
    activeOnly: true,
    afterId,
    limit,
    maxRunMs: MAX_RUN_MS,
    adapter: { maxItems: MAX_JOBS_PER_BOARD },
    enforceLifecycle: parseEnforceFlag(env.LIFECYCLE_CLOSE_ENFORCE),
    // Tier-1 universal staleness sweep — runs EVERY tick (driven by the deployed feature, not gated on the
    // switch) so the would-close population is observed in shadow; `enforce` rides its OWN STALE_SWEEP flag,
    // independent of LIFECYCLE_CLOSE_ENFORCE, so it stays count-only until the owner flips it after reading the counts.
    staleSweep: { ttlDays: staleTtlDays, enforce: parseEnforceFlag(env.STALE_SWEEP) },
  });

  // Wrap to the start (afterId 0) ONLY when the whole chunk was processed AND it under-filled
  // (companies < limit ⇒ the id-keyset sweep reached the end of the table). If the maxRunMs budget
  // stopped the loop early (processed < companies) there are still boards left in THIS chunk, so advance
  // to the last processed id and continue it next tick — never wrap mid-chunk (that would skip the rest).
  const reachedEnd = counts.processed >= counts.companies && counts.companies < limit;
  const next = reachedEnd ? 0 : counts.lastId;
  await env.INGEST_CURSOR.put("afterId", String(next));
}
