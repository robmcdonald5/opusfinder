/**
 * Phase F8 — the two async-backfill drains, as Inngest scheduled (cron) functions.
 *
 * Every ingested job lands with `embedding` and `enriched_at` NULL (the Node-free scraper Worker can't run
 * embed/enrich), and a NULL-embedding job is invisible to matching. These cron functions drain that backlog
 * daily on the deployed Node runtime (Phase-12 12a: inngest/sveltekit on Vercel), wrapping the SAME repo
 * primitives the `embeddings:backfill` / `enrich:backfill` CLIs use — no repo or schema change.
 *
 * Why NOT call backfillJobEmbeddings / backfillJobEnrichment directly: each runs an unbounded in-process
 * loop to backlog exhaustion, which would blow Vercel's maxDuration (the SvelteKit serve can't stream). So
 * each drain pages the low-level primitives ONE page per `step.run`, mirroring the digest's bounded poll
 * loop (digest.ts): a per-page bound keeps one step short, and MAX_PAGES_PER_RUN bounds the per-invocation
 * step count (a deep backlog finishes across subsequent daily runs — both drains are idempotent).
 *
 * The two drains page DIFFERENTLY and must NOT be unified:
 *   - embedding is CURSORLESS — a written row drops out of `embedding IS NULL`, so the next no-offset query
 *     returns the following rows;
 *   - enrichment is KEYSET — a row whose extraction THROWS stays `enriched_at IS NULL`, so a cursorless
 *     re-query would re-select it forever within a run; the cursor (`afterId`) advances past it. The cursor
 *     lives in the fn-local loop var, fed by each step's MEMOIZED return, so it survives replay.
 */
import {
  jobEmbeddingText,
  jobsNeedingEmbedding,
  jobsNeedingEnrichment,
  writeJobEmbeddings,
  writeJobEnrichment,
  type ExtractFn,
} from "@opusfinder/db/repos";
import type { Db } from "@opusfinder/db";
import type { JobEnrichment } from "@opusfinder/shared";
import { NonRetriableError } from "inngest";

import { inngest } from "./inngest";

/**
 * The embedder shape the embed drain needs, declared structurally so this module need not import
 * `@opusfinder/embeddings` (kept injectable/portable, like `EmbedFn` in repos/embeddings.ts). The real
 * `embed` from `@opusfinder/embeddings` is structurally assignable (its extra `model` return field and
 * optional params are compatible), so `buildBackfillDeps()` passes it directly.
 */
type EmbedFn = (
  texts: string[],
  params: { inputType: "query" | "document" | null },
) => Promise<{ embeddings: number[][]; usage: { totalTokens: number } }>;

/** Injected seams — wired by `buildBackfillDeps()` (./backfill-deps). Mirrors `DigestDeps`. */
export interface BackfillDeps {
  db: Db;
  embed: EmbedFn;
  extract: ExtractFn;
}

// --- Tunables ---------------------------------------------------------------------------------------
/** Jobs embedded per page. ≤128 (Voyage's per-request item cap) ⇒ exactly one Voyage request per page; ≪
 *  writeJobEmbeddings' 1000-row chunk ⇒ one UPDATE per page. Matches the CLI default. */
const EMBED_PAGE = 64;
/** Jobs enriched per page = the concurrent Anthropic burst (the page extracts under one Promise.all).
 *  Matches the CLI default; raise with care — concurrency scales 1:1 with Haiku rate-limit pressure. */
const ENRICH_PAGE = 8;
/** Bound the per-invocation STEP count (not just per-page time): a deep backlog otherwise emits too many
 *  step.run iterations for one Inngest request (the digest fn already sits ~340 steps). A run that hits the
 *  cap returns `drained:false`; the next daily cron resumes (idempotent). At 64/page ≈ 12,800 rows/run. */
const MAX_PAGES_PER_RUN = 200;

/**
 * embed-backlog-drain — fill `jobs.embedding` daily (this gates matching). Cursorless paging: re-query the
 * NULL set each page, embed it, write it back; a written page leaves the filter so the next page is the next
 * rows. `singleton skip` (keyless ⇒ one global flight) drops a tick that fires while a deep-backlog run is
 * still draining, so there is no overlapping Voyage spend.
 */
function makeEmbedDrain(deps: BackfillDeps) {
  return inngest.createFunction(
    { id: "embed-backlog-drain", singleton: { mode: "skip" } },
    { cron: "0 4 * * *" }, // 04:00 UTC — after the night of hourly ingestion, clear of the digest cadence
    async ({ step }) => {
      let pages = 0;
      let processed = 0;
      let tokens = 0;
      let drained = false;
      for (let i = 0; i < MAX_PAGES_PER_RUN; i++) {
        // Step id derives ONLY from the loop index (never ctx.attempt — that would orphan a retried step,
        // per digest.ts). Each page is its own step.run = one Voyage request + one UPDATE.
        const page = await step.run(`embed-page-${i}`, async () => {
          const batch = await jobsNeedingEmbedding(deps.db, { limit: EMBED_PAGE });
          if (batch.length === 0) return { processed: 0, tokens: 0, done: true };
          const { embeddings, usage } = await deps.embed(
            batch.map((job) => jobEmbeddingText(job)),
            { inputType: "document" },
          );
          // A length mismatch is a deterministic bug — fail terminally rather than burn paid retries.
          if (embeddings.length !== batch.length) {
            throw new NonRetriableError(
              `embed returned ${embeddings.length} vectors for ${batch.length} jobs`,
            );
          }
          const written = await writeJobEmbeddings(
            deps.db,
            batch.map((job, k) => ({ id: job.id, embedding: embeddings[k] as number[] })),
          );
          return { processed: written, tokens: usage.totalTokens, done: batch.length < EMBED_PAGE };
        });
        pages++;
        processed += page.processed;
        tokens += page.tokens;
        if (page.done) {
          drained = true;
          break;
        }
      }
      // `drained:false` ⇒ the page cap was hit on a deep backlog; the next daily cron finishes the tail.
      return { pages, processed, tokens, drained };
    },
  );
}

/**
 * enrich-backlog-drain — fill `jobs.enriched_at` + the F4 structured columns daily (feeds the deferred
 * F4-FILTER). Keyset paging on `id`: a page extracts ENRICH_PAGE jobs concurrently, writes the successes,
 * and leaves a throwing row un-stamped (counted `failed`, retried next run) exactly like the CLI drain. The
 * cursor is threaded across steps via each page's memoized return.
 */
function makeEnrichDrain(deps: BackfillDeps) {
  return inngest.createFunction(
    { id: "enrich-backlog-drain", singleton: { mode: "skip" } },
    { cron: "15 4 * * *" }, // 04:15 UTC — staggered after embed so the Voyage / Anthropic bursts don't overlap
    async ({ step }) => {
      let cursor = 0;
      let pages = 0;
      let processed = 0;
      let failed = 0;
      let drained = false;
      for (let i = 0; i < MAX_PAGES_PER_RUN; i++) {
        const afterId = cursor; // per-iteration capture — the closure must not close over the mutated `cursor`
        const page = await step.run(`enrich-page-${i}`, async () => {
          const batch = await jobsNeedingEnrichment(deps.db, { afterId, limit: ENRICH_PAGE });
          if (batch.length === 0) return { processed: 0, failed: 0, nextCursor: afterId, done: true };
          const nextCursor = batch[batch.length - 1]!.id; // advance past the whole batch, incl. throwers
          // Mirror drainEnrichment: per-row try/catch, shape-only warn (id + error NAME, never the message —
          // no secrets/PII in logs), throwers left un-stamped so the next run retries them.
          const settled = await Promise.all(
            batch.map(async (job) => {
              try {
                return { id: job.id, enrichment: await deps.extract(job) };
              } catch (err) {
                console.warn(
                  `enrich: job ${job.id} extraction failed (${(err as Error)?.name ?? "Error"})`,
                );
                return null;
              }
            }),
          );
          const ok = settled.filter(
            (r): r is { id: number; enrichment: JobEnrichment } => r !== null,
          );
          const written = ok.length > 0 ? await writeJobEnrichment(deps.db, ok) : 0;
          return {
            processed: written,
            failed: batch.length - ok.length,
            nextCursor,
            done: batch.length < ENRICH_PAGE,
          };
        });
        pages++;
        processed += page.processed;
        failed += page.failed;
        cursor = page.nextCursor; // fed by the memoized step return ⇒ deterministic across replay
        if (page.done) {
          drained = true;
          break;
        }
      }
      return { pages, processed, failed, drained };
    },
  );
}

/** The F8 backfill functions, built with injected deps — concatenated alongside the digest functions in the
 *  serve route. Mirrors `createDigestFunctions`. */
export function createBackfillFunctions(deps: BackfillDeps) {
  return [makeEmbedDrain(deps), makeEnrichDrain(deps)];
}
