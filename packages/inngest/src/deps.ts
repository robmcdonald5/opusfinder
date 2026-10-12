import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { getEmailLastEvent, sendDigestEmail } from "@opusfinder/email";
import {
  collectBatchResults,
  generateObject,
  ObjectGenerationError,
  pollBatch,
  RerankScoresSchema,
  renderRerankCandidates,
  submitBatch,
} from "@opusfinder/llm";
import { rerankCandidates, type RerankCall, type RerankCandidate } from "@opusfinder/rerank";
import { parseEnforceFlag } from "@opusfinder/shared";
import type { PromptPreferences, StructuredProfile } from "@opusfinder/shared";

import type { DigestDeps, RerankOutcome } from "./digest";
import { probeLiveness } from "./probe";

/**
 * Build the production digest deps: a neon-http db + the real synchronous Haiku rerank (the shared
 * `@opusfinder/rerank` core wired to `generateObject`) + the Anthropic Message Batches primitives for
 * synthesis + the Resend email send/last_event pair. NODE/server-only — it reads env via the `/env`
 * subpaths; the serve + CLI scripts call it. Never reached from a Worker (`guard:worker` keeps
 * `@opusfinder/inngest` out of the scraper bundle). Importing `@opusfinder/email` here pulls only its
 * `loadPackageEnv` side effect — the Resend getters throw at CALL time, so the serve process still boots
 * without email creds (an unconfigured send then terminalizes to `delivery_status='failed'`).
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
    email: {
      send: (payload) => sendDigestEmail(payload),
      lastEvent: (emailId) => getEmailLastEvent(emailId),
    },
    probe: probeLiveness,
    // Lifecycle-close enforcement — reads LIFECYCLE_CLOSE_ENFORCE from process.env (Node-hosted), the same switch the
    // Worker reads. Default false = shadow.
    enforceLifecycle: parseEnforceFlag(process.env.LIFECYCLE_CLOSE_ENFORCE),
  };
}

/** The real rerank seam: run the shared core, scoring each chunk with a cached Haiku `generateObject`
 *  and aggregating the token and prompt-cache counters across chunks (surfaced for the "cache hit >0"
 *  gate). A chunk whose reply is unusable (truncated, refused, off-schema) is left unscored rather than
 *  failing the rerank: those candidates fall below the score floor, and the chunks already paid for count.
 *  Provider errors still throw. */
function buildRerank(): DigestDeps["rerank"] {
  return async (
    profile: StructuredProfile,
    candidates: RerankCandidate[],
    prefs?: PromptPreferences,
  ): Promise<RerankOutcome> => {
    let inputTokens = 0;
    let outputTokens = 0;
    let creationInputTokens = 0;
    let readInputTokens = 0;
    const call: RerankCall = async (system, chunk) => {
      try {
        const { object, usage, cache } = await generateObject({
          model: "haiku",
          system,
          cacheSystem: true,
          schema: RerankScoresSchema,
          messages: [{ role: "user", content: renderRerankCandidates(chunk) }],
          maxOutputTokens: 2048,
          // The scores feed a hard MIN_SCORE floor, so sampling noise would flip borderline jobs in and out.
          temperature: 0,
        });
        inputTokens += usage.inputTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
        creationInputTokens += cache.creationInputTokens;
        readInputTokens += cache.readInputTokens;
        return object.scores;
      } catch (err) {
        if (!(err instanceof ObjectGenerationError)) throw err;
        console.warn(
          `rerank: chunk left unscored (jobs ${chunk.map((c) => c.id).join(",")}): ${err.message}`,
        );
        return [];
      }
    };
    const { orderedIds, scores } = await rerankCandidates(profile, candidates, call, { prefs });
    return {
      orderedIds,
      scores,
      usage: { inputTokens, outputTokens },
      cache: { creationInputTokens, readInputTokens },
    };
  };
}
