import { createDb, type Db } from "@opusfinder/db";
import { runDiscovery } from "@opusfinder/discovery";
import { embed } from "@opusfinder/embeddings";
import { runIngestion, type IngestEmbedFn } from "@opusfinder/sources";

/**
 * The opusfinder scrapers Worker (Phase 8): two scheduled (cron) handlers — ingestion (frequent)
 * and discovery (weekly) — dispatched on `controller.cron`. Each builds the neon-http client with
 * `createDb(env.DATABASE_URL)` (fetch-only, no `process.env`) and calls an already-Worker-forward
 * library (`runIngestion` / `runDiscovery`) that owns its own `source_runs` row.
 *
 * The cron strings below MUST match wrangler.toml [triggers].crons CHARACTER-FOR-CHARACTER — in
 * particular the discovery weekday: Cloudflare numbers weekdays 1=Sun..7=Sat, so it is "SUN",
 * never "0" (a numeric 0 is out-of-range and the branch would never fire).
 *
 * The handler AWAITS the dispatched work (rather than fire-and-forget `ctx.waitUntil`) inside one
 * try/catch, so a failure in the KV cursor I/O or the pipeline is logged to `wrangler tail` AND
 * re-thrown so Cloudflare records the invocation as errored.
 */
interface Env {
  /** Neon connection string (a `wrangler secret`). */
  DATABASE_URL: string;
  /** Voyage API key (a `wrangler secret`) — needed ONLY when inline embedding is enabled, so optional. */
  VOYAGE_API_KEY?: string;
  /** Chunk-cursor store for the Option-A chunked-cron ingestion lane (a KV namespace binding). */
  INGEST_CURSOR: KVNamespace;
  /** Boards per ingestion tick (the wall/subrequest budget). Default 150. */
  INGEST_LIMIT?: string;
  /** "true" enables inline embedding during ingestion. Off by default (Voyage free-tier 3 RPM cap). */
  INGEST_EMBED?: string;
}

// Must equal the wrangler.toml cron strings exactly (esp. the weekday — "SUN", not "0").
const INGEST_CRON = "*/30 * * * *";
const DISCOVERY_CRON = "0 3 * * SUN";

const DEFAULT_INGEST_LIMIT = 150;
// limit + reprobeLimit sized to the subrequest budget (PHASE_8_PLAN.md §6 — REQUIRES Workers Paid).
const DISCOVERY_LIMIT = 400;
const DISCOVERY_REPROBE_LIMIT = 500;

export default {
  async scheduled(controller, env): Promise<void> {
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
          break;
        case DISCOVERY_CRON:
          await runDiscovery(db, { limit: DISCOVERY_LIMIT, reprobeLimit: DISCOVERY_REPROBE_LIMIT });
          break;
        default:
          console.warn(`Unhandled cron: ${controller.cron}`);
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
 * One ingestion tick: read the chunk cursor from KV, process the next `INGEST_LIMIT` boards via
 * `runIngestion`, then advance or wrap the cursor. `counts.companies` is the boards processed this
 * tick (the SQL chunk), so `companies < limit` ⇒ the chunk under-filled ⇒ the sweep reached the end
 * ⇒ wrap to the start; otherwise advance past the last id processed.
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
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : DEFAULT_INGEST_LIMIT;

  const embedEnabled = env.INGEST_EMBED === "true";
  if (embedEnabled && !env.VOYAGE_API_KEY) {
    console.warn(
      "INGEST_EMBED=true but VOYAGE_API_KEY is not set — inline embedding will fail per board.",
    );
  }
  // The embed closure is wired (the Voyage key is injected from the secret); enabled only when
  // INGEST_EMBED="true" once a Voyage card lifts the free-tier 3 RPM cap (§2.4 / F-EMBED).
  const workerEmbed: IngestEmbedFn = (texts, params) =>
    embed(texts, { ...params, apiKey: env.VOYAGE_API_KEY });

  const counts = await runIngestion(db, {
    activeOnly: true,
    afterId,
    limit,
    embed: embedEnabled ? workerEmbed : undefined,
  });

  const next = counts.companies < limit ? 0 : counts.lastId;
  await env.INGEST_CURSOR.put("afterId", String(next));
}
