/**
 * The async embedding-backfill drain, as an Inngest scheduled (cron) function.
 *
 * Every ingested job lands with `embedding` NULL (the Node-free scraper Worker can't run embed), and a
 * NULL-embedding job is invisible to matching. This cron function drains that backlog daily on the deployed
 * Node runtime (inngest/sveltekit on Vercel), wrapping the SAME repo primitive the `embeddings:backfill` CLI
 * uses — no repo or schema change.
 *
 * Why NOT call backfillJobEmbeddings directly: it runs an unbounded in-process loop to backlog exhaustion,
 * which would blow Vercel's maxDuration (the SvelteKit serve can't stream). So the drain pages the low-level
 * primitives ONE page per `step.run`, mirroring the digest's bounded poll loop: a per-page bound keeps one
 * step short, and MAX_PAGES_PER_RUN bounds the per-invocation step count (a deep backlog finishes across
 * subsequent daily runs — the drain is idempotent).
 *
 * Paging is CURSORLESS — a written row drops out of `embedding IS NULL`, so the next no-offset query returns
 * the following rows.
 */
import {
  jobEmbeddingText,
  jobsNeedingEmbedding,
  writeJobEmbeddings,
} from "@opusfinder/db/repos";
import type { Db } from "@opusfinder/db";
import { NonRetriableError } from "inngest";

import { inngest } from "./inngest";

/** The embedder shape the embed drain needs, declared structurally so this module need not import
 *  `@opusfinder/embeddings`. The real `embed` is structurally assignable, so `buildBackfillDeps()` passes it
 *  directly. */
type EmbedFn = (
  texts: string[],
  params: { inputType: "query" | "document" | null },
) => Promise<{ embeddings: number[][]; usage: { totalTokens: number } }>;

/** Injected seams — wired by `buildBackfillDeps()` (./backfill-deps). Mirrors `DigestDeps`. */
export interface BackfillDeps {
  db: Db;
  embed: EmbedFn;
}

/** Jobs embedded per page. ≤128 (Voyage's per-request item cap) ⇒ exactly one Voyage request per page; ≪
 *  writeJobEmbeddings' 1000-row chunk ⇒ one UPDATE per page. Matches the CLI default. */
const EMBED_PAGE = 64;
/** Bound the per-invocation STEP count (not just per-page time): a deep backlog otherwise emits too many
 *  step.run iterations for one Inngest request (the digest fn already sits ~340 steps). A run that hits the
 *  cap returns `drained:false`; the next daily cron resumes (idempotent). At 64/page ≈ 12,800 rows/run. */
const MAX_PAGES_PER_RUN = 200;

/** The one step primitive the drain uses — structural, so a test drives it with a recording fake step and
 *  Inngest's real StepTools pass straight through. */
export interface EmbedDrainStepTools {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * The embed-drain loop body, extracted from the Inngest handler so its page / mismatch / cap branches are
 * unit-testable with a recording fake `step` + stubbed repo primitives (no real Neon / Voyage). Pages the
 * backlog ONE page per `step.run` (each = one Voyage request + one UPDATE), bounded by MAX_PAGES_PER_RUN.
 * Cursorless: a written row drops out of `embedding IS NULL`, so the next no-offset query returns the rows
 * after it.
 *   - empty batch, or a short (<EMBED_PAGE) last page ⇒ done ⇒ drained:true, stop.
 *   - a vector/batch length mismatch ⇒ NonRetriableError (a deterministic bug — don't burn paid retries).
 *   - the page cap hit on a deep backlog ⇒ drained:false; the next daily cron resumes (idempotent).
 */
export async function embedDrainStep(
  deps: BackfillDeps,
  step: EmbedDrainStepTools,
): Promise<{ pages: number; processed: number; tokens: number; drained: boolean }> {
  let pages = 0;
  let processed = 0;
  let tokens = 0;
  let drained = false;
  for (let i = 0; i < MAX_PAGES_PER_RUN; i++) {
    // Step id derives ONLY from the loop index (never ctx.attempt — that would orphan a retried step).
    // Each page is its own step.run = one Voyage request + one UPDATE.
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
}

/**
 * embed-backlog-drain — fill `jobs.embedding` daily (this gates matching). `singleton skip` (keyless ⇒ one
 * global flight) drops a tick that fires while a deep-backlog run is still draining, so there is no
 * overlapping Voyage spend.
 */
function makeEmbedDrain(deps: BackfillDeps) {
  return inngest.createFunction(
    { id: "embed-backlog-drain", singleton: { mode: "skip" } },
    { cron: "0 4 * * *" }, // 04:00 UTC — after the night of hourly ingestion, clear of the digest cadence
    // The adapter passes Inngest's tools through; the cast is sound — the page step's return
    // ({processed,tokens,done}) is a JSON fixed-point, so Inngest's Jsonify memoization is the identity on it.
    ({ step }) =>
      embedDrainStep(deps, {
        run: async (id, fn) => (await step.run(id, fn)) as Awaited<ReturnType<typeof fn>>,
      }),
  );
}

/** The backfill functions, built with injected deps — concatenated alongside the digest functions in the
 *  serve route. Mirrors `createDigestFunctions`. */
export function createBackfillFunctions(deps: BackfillDeps) {
  return [makeEmbedDrain(deps)];
}
