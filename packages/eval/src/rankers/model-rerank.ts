/**
 * A real `RerankCall` for any model: the digest's rerank request (the cached rubric + profile system, the
 * rendered candidate chunk, the score schema, a 4096-token cap) sent through the eval's own caller, so a
 * head-to-head can put a non-Anthropic model behind the same `rerankCandidates` core. Pass it to
 * `llmRerankRanker(call)`; the ranker's default stays the deterministic stub.
 */
import { RerankScoresSchema, renderRerankCandidates } from "@opusfinder/llm";
import type { RerankCall } from "@opusfinder/rerank";

import {
  callModel,
  ModelReplyError,
  type ModelCallUsage,
  type ModelRoute,
  type ReasoningEffort,
  type Served,
} from "../model-caller";

export interface ModelRerankOptions {
  /** Default `low`, the digest's setting. */
  effort?: ReasoningEffort;
  /** Called once per reply, usable or not, with what it cost and who served it. */
  onReply?: (reply: { usage: ModelCallUsage; served: Served }) => void;
}

/**
 * Build the rerank call for `route`. As in the digest, a chunk whose reply is unusable (truncated, refused,
 * off-schema) is left unscored for the core to backfill. A reply from an unpinned host is not: it throws,
 * because a run that mixes hosts is not the run that was asked for.
 */
export function modelRerankCall(route: ModelRoute, opts: ModelRerankOptions = {}): RerankCall {
  return async (system, chunk) => {
    try {
      const result = await callModel({
        route,
        system,
        cacheSystem: true,
        schema: RerankScoresSchema,
        schemaName: "rerank_scores",
        messages: [{ role: "user", content: renderRerankCandidates(chunk) }],
        reasoningEffort: opts.effort ?? "low",
        maxOutputTokens: 4096,
      });
      opts.onReply?.({
        usage: result.usage,
        served: { host: result.host, model: result.servedModel },
      });
      return result.object.scores;
    } catch (err) {
      if (!(err instanceof ModelReplyError)) throw err;
      opts.onReply?.({ usage: err.spent, served: err.served });
      if (err.reason === "unpinned_host") throw err;
      console.warn(
        `rerank: chunk left unscored (jobs ${chunk.map((c) => c.id).join(",")}): ${err.message}`,
      );
      return [];
    }
  };
}
