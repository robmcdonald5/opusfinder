import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import {
  collectBatchResults,
  generateObject,
  pollBatch,
  RerankScoresSchema,
  renderRerankCandidates,
  submitBatch,
} from "@opusfinder/llm";
import { rerankCandidates, type RerankCall, type RerankCandidate } from "@opusfinder/rerank";
import type { StructuredProfile } from "@opusfinder/shared";

import type { DigestDeps, RerankOutcome } from "./digest";

/**
 * Build the production digest deps: a neon-http db + the real synchronous Haiku rerank (the shared
 * `@opusfinder/rerank` core wired to `generateObject`) + the Anthropic Message Batches primitives for
 * synthesis. NODE/server-only — it reads env via the `/env` subpaths; the serve + CLI scripts call it.
 * Never reached from a Worker (`guard:worker` keeps `@opusfinder/inngest` out of the scraper bundle).
 */
export function buildDigestDeps(): DigestDeps {
  const db = createDb(getDatabaseUrl());
  return {
    db,
    rerank: buildRerank(),
    batch: {
      submit: (requests) => submitBatch(requests),
      poll: (batchId) => pollBatch(batchId),
      collect: (batchId) => collectBatchResults(batchId),
    },
  };
}

/** The real rerank seam: run the shared core, scoring each chunk with a cached Haiku `generateObject`
 *  and aggregating the prompt-cache counters across chunks (surfaced for the "cache hit >0" gate). */
function buildRerank(): DigestDeps["rerank"] {
  return async (
    profile: StructuredProfile,
    candidates: RerankCandidate[],
  ): Promise<RerankOutcome> => {
    let creationInputTokens = 0;
    let readInputTokens = 0;
    const call: RerankCall = async (system, chunk) => {
      const { object, cache } = await generateObject({
        model: "haiku",
        system,
        cacheSystem: true,
        schema: RerankScoresSchema,
        messages: [{ role: "user", content: renderRerankCandidates(chunk) }],
        maxOutputTokens: 2048,
      });
      creationInputTokens += cache.creationInputTokens;
      readInputTokens += cache.readInputTokens;
      return object.scores;
    };
    const { orderedIds, scores } = await rerankCandidates(profile, candidates, call);
    return { orderedIds, scores, cache: { creationInputTokens, readInputTokens } };
  };
}
