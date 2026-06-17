import { createDb, type Db } from "@opusfinder/db";
import { runDiscovery } from "@opusfinder/discovery";
import { parseEnforceFlag } from "@opusfinder/shared";
import { runIngestion } from "@opusfinder/sources";

/**
 * The opusfinder scrapers Worker (Phase 8): two scheduled (cron) handlers — ingestion (frequent)
 * and discovery (weekly) — dispatched on `controller.cron`. Each builds the neon-http client with
 * `createDb(env.DATABASE_URL)` (fetch-only, no `process.env`) and calls an already-Worker-forward
 * library (`runIngestion` / `runDiscovery`) that owns its own `source_runs` row.
 *
 * The Worker imports ONLY fetch-based libraries — no Node-targeted package enters the bundle — so it
 * needs no `nodejs_compat`. Inline embedding is intentionally NOT wired here: it is off by default on
 * the Voyage free tier (§2.4 / F-EMBED), and wiring `@opusfinder/embeddings` would drag its dotenv
 * env-module into the Worker (and require nodejs_compat). Jobs are upserted regardless; the still-NULL
 * vectors are filled by `pnpm embeddings:backfill`. To enable inline embedding later:
 *   1. `import { embed } from "@opusfinder/embeddings";`
 *      `import { type IngestEmbedFn } from "@opusfinder/sources";`
 *   2. build `const workerEmbed: IngestEmbedFn = (t, p) => embed(t, { ...p, apiKey: env.VOYAGE_API_KEY });`
 *      and pass `embed: workerEmbed` to runIngestion (guarded by an INGEST_EMBED flag);
 *   3. add the `VOYAGE_API_KEY` secret + `compatibility_flags = ["nodejs_compat"]` in wrangler.toml.
 *
 * The cron strings below MUST match wrangler.toml [triggers].crons CHARACTER-FOR-CHARACTER — in
 * particular the discovery weekday: Cloudflare numbers weekdays 1=Sun..7=Sat, so it is "SUN", never
 * "0". The handler AWAITS the dispatched PIPELINE work (not fire-and-forget `ctx.waitUntil`) in one
 * try/catch, so a failure in the KV cursor I/O or the pipeline is logged to `wrangler tail` and re-thrown
 * so Cloudflare records the invocation as errored. The ONE `ctx.waitUntil` exception is the Phase-F6
 * liveness heartbeat ({@link pingWatchdog}): a content-free ping to an external watchdog on a SUCCESSFUL
 * tick, run non-blocking so a watchdog hiccup can never fail the tick. GUARD: `pnpm guard:worker`
 * substring-scans this file (comments included, case-sensitive) for the forbidden server-only package
 * imports — which the heartbeat trips none of (the ping target lives ONLY in `env.HEALTH_PING_URL`, a
 * secret). The guard does NOT detect a provider/watchdog HOST literal, so by author discipline never
 * write one (or any forbidden package name) anywhere in this file.
 */
interface Env {
  /** Neon connection string (a `wrangler secret`). */
  DATABASE_URL: string;
  /** Chunk-cursor store for the Option-A chunked-cron ingestion lane (a KV namespace binding). */
  INGEST_CURSOR: KVNamespace;
  /** Boards per ingestion tick (the wall/subrequest budget). Default 150. */
  INGEST_LIMIT?: string;
  /** External-watchdog ping URL (a `wrangler secret`) — the Phase-F6 liveness heartbeat. OPTIONAL: when
   *  unset the heartbeat is skipped silently (so the Worker can redeploy before the watchdog account
   *  exists). See {@link pingWatchdog}. */
  HEALTH_PING_URL?: string;
  /** F2 lifecycle-close enforcement (the single switch across Arms A/B/C — see {@link parseEnforceFlag}).
   *  A wrangler `[vars]` value. Unset / "shadow" = count-only (the default); "enforce" flips the `'closed'`
   *  write on for the per-board sweep (Arm A) AND the board-death close (Arm B). Keep it in sync with the
   *  digest runtime's `F2_ENFORCE` so all three arms enforce together. */
  F2_ENFORCE?: string;
}

// Must equal the wrangler.toml cron strings exactly (esp. the weekday — "SUN", not "0"). Ingestion is
// HOURLY (Phase F6 dialed it back from */30 — see wrangler.toml [triggers] for the rationale).
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
// limit + reprobeLimit sized to the subrequest budget (PHASE_8_PLAN.md §6 — REQUIRES Workers Paid).
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
          // workerOnly: run only workerSafe (fetch-only, bundle-safe) lanes — the F5-LANES-2 guard so a
          // future Node-only lane (passive DNS / Common Crawl) can never execute inside the isolate.
          await runDiscovery(db, {
            limit: DISCOVERY_LIMIT,
            reprobeLimit: DISCOVERY_REPROBE_LIMIT,
            workerOnly: true,
            // F2 Arm B enforcement — the one shared switch (off by default = shadow).
            enforceLifecycle: parseEnforceFlag(env.F2_ENFORCE),
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
      // only place those failures (and any infrastructural throw) are caught. Log for `wrangler tail`
      // then re-throw so the Cloudflare cron event records this invocation as errored.
      console.error(
        `scheduled(${controller.cron}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Fire-and-forget liveness heartbeat (Phase F6) — a content-free ping to an external watchdog (a free
 * dead-man's-switch) on each SUCCESSFUL ingestion tick. The watchdog emails the owner when the pings
 * STOP after its grace window — the ONLY way to detect the cron's OWN death: a paused/dead cron emits
 * nothing, so a co-located checker is silent exactly when the outage happens (PHASE_F6_PLAN.md §2.5).
 * Detection is by ping ABSENCE, not a /fail ping.
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

  // Inline embedding is OFF (not wired — see the module doc-comment). Jobs are upserted; the still-NULL
  // vectors are filled by `pnpm embeddings:backfill`. The per-board cap + run budget keep one tick inside
  // the Worker's per-invocation limits regardless of how heavy the chunk is.
  const counts = await runIngestion(db, {
    activeOnly: true,
    afterId,
    limit,
    maxRunMs: MAX_RUN_MS,
    adapter: { maxItems: MAX_JOBS_PER_BOARD },
    // F2 Arm A enforcement — the one shared switch (off by default = shadow).
    enforceLifecycle: parseEnforceFlag(env.F2_ENFORCE),
  });

  // Wrap to the start (afterId 0) ONLY when the whole chunk was processed AND it under-filled
  // (companies < limit ⇒ the id-keyset sweep reached the end of the table). If the maxRunMs budget
  // stopped the loop early (processed < companies) there are still boards left in THIS chunk, so advance
  // to the last processed id and continue it next tick — never wrap mid-chunk (that would skip the rest).
  const reachedEnd = counts.processed >= counts.companies && counts.companies < limit;
  const next = reachedEnd ? 0 : counts.lastId;
  await env.INGEST_CURSOR.put("afterId", String(next));
}
