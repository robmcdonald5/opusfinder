import { createDb } from "@opusfinder/db";
import { getEmailLastEvent, sendDigestEmail, type EmailConfig } from "@opusfinder/email";
import {
  collectBatchResults,
  generateObject,
  ObjectGenerationError,
  pollBatch,
  RerankScoresSchema,
  renderRerankCandidates,
  submitBatch,
  type LlmConfig,
} from "@opusfinder/llm";
import { rerankCandidates, type RerankCall, type RerankCandidate } from "@opusfinder/rerank";
import type { PromptPreferences, StructuredProfile } from "@opusfinder/shared";

import type { DigestDeps, RerankOutcome } from "./digest";
import { probeLiveness } from "./probe";

/** What the production digest deps are built from. A Worker passes its bindings; a key left out is read
 *  from the environment when it is first used (Node callers). */
export interface DigestConfig {
  /** The Postgres connection string (neon-http: the digest's writes need no transaction). */
  databaseUrl: string;
  /** The OpenRouter key for the rerank and the synthesis batch. */
  llm?: LlmConfig;
  /** The Resend send key, the full-access key the delivery poll reads with, and the sender. */
  email?: EmailConfig;
  /** Lifecycle-close enforcement, parsed from the runtime's LIFECYCLE_CLOSE_ENFORCE (the same switch the
   *  scrapers Worker reads). Default false = shadow. */
  enforceLifecycle?: boolean;
}

/**
 * Build the production digest deps: a neon-http db + the real synchronous Haiku rerank (the shared
 * `@opusfinder/rerank` core wired to `generateObject`) + the OpenRouter Batch API primitives for
 * synthesis + the Resend email send/last_event pair. Reads nothing at
 * import and no environment of its own, so it bundles for a Worker. The Resend keys are read at CALL
 * time: a runtime without them still starts, and an unconfigured send terminalizes to
 * `delivery_status='failed'`.
 */
export function buildDigestDeps(config: DigestConfig): DigestDeps {
  const llm = config.llm ?? {};
  const email = config.email ?? {};
  return {
    db: createDb(config.databaseUrl),
    rerank: buildRerank(llm),
    batch: {
      submit: (requests) => submitBatch(requests, llm),
      poll: (batchId) => pollBatch(batchId, llm),
      collect: (batchId) => collectBatchResults(batchId, llm),
    },
    email: {
      send: (payload) => sendDigestEmail(payload, email),
      lastEvent: (emailId) => getEmailLastEvent(emailId, email),
    },
    probe: probeLiveness,
    enforceLifecycle: config.enforceLifecycle ?? false,
  };
}

/** The real rerank seam: run the shared core, scoring each chunk with a cached Haiku `generateObject`
 *  and aggregating the token, cost and prompt-cache counters across chunks (surfaced for the "cache hit >0"
 *  gate). A chunk whose reply is unusable (truncated, refused, off-schema) is left unscored rather than
 *  failing the rerank: those candidates fall below the score floor, and every chunk paid for counts,
 *  unscored ones included. Provider errors still throw. */
function buildRerank(llm: LlmConfig): DigestDeps["rerank"] {
  return async (
    profile: StructuredProfile,
    candidates: RerankCandidate[],
    prefs?: PromptPreferences,
  ): Promise<RerankOutcome> => {
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const cache = { creationInputTokens: 0, readInputTokens: 0 };
    const count = (spent: Pick<RerankOutcome, "usage" | "cache">) => {
      usage.inputTokens += spent.usage.inputTokens;
      usage.outputTokens += spent.usage.outputTokens;
      usage.costUsd += spent.usage.costUsd;
      cache.creationInputTokens += spent.cache.creationInputTokens;
      cache.readInputTokens += spent.cache.readInputTokens;
    };
    const call: RerankCall = async (system, chunk) => {
      try {
        const result = await generateObject({
          ...llm,
          model: "haiku",
          system,
          cacheSystem: true,
          schema: RerankScoresSchema,
          messages: [{ role: "user", content: renderRerankCandidates(chunk) }],
          effort: "low",
          maxOutputTokens: 4096,
        });
        count(result);
        return result.object.scores;
      } catch (err) {
        if (!(err instanceof ObjectGenerationError)) throw err;
        count(err.spent);
        console.warn(
          `rerank: chunk left unscored (jobs ${chunk.map((c) => c.id).join(",")}): ${err.message}`,
        );
        return [];
      }
    };
    const { orderedIds, scores } = await rerankCandidates(profile, candidates, call, { prefs });
    return { orderedIds, scores, usage, cache };
  };
}
