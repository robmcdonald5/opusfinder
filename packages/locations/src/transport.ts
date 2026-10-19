/**
 * The production {@link LocationModel}: the location normalizer's requests over @opusfinder/llm (Claude
 * Haiku through OpenRouter). Every caller (the digest deps, the locations CLIs, eval:locations) builds the
 * model here, so the transport is wired in one place. Both paths send the same call options: the cached
 * system block, the pair as the user turn, the answer schema as structured output, low effort, no thinking.
 */
import {
  batchGenerate,
  generateObject,
  ObjectGenerationError,
  type BatchRequest,
  type BatchResult,
  type CallOptions,
} from "@opusfinder/llm";

import type { LocationAnswer, LocationModel, LocationRequest } from "./model";

/** Requests per provider batch. Every request repeats the ~8 KB system block, so 2,000 keeps a submit near
 *  16 MB; a larger set goes out as several batches at once and is waited on together. */
const BATCH_SIZE = 2000;
/** Batches take minutes to hours; poll gently. */
const BATCH_POLL_MS = 30_000;

export function createLocationModel(): LocationModel {
  return {
    async generate(request) {
      try {
        const { object } = await generateObject({
          ...callOptions(request),
          schema: request.schema,
        });
        return { status: "answered", text: JSON.stringify(object) };
      } catch (err) {
        // A reply with nothing usable in it (cut off, refused, off-schema after the retry) is no answer;
        // provider and network errors still throw.
        if (err instanceof ObjectGenerationError)
          return { status: "no-answer", reason: err.message };
        throw err;
      }
    },
    async batch(requests) {
      const chunks: LocationRequest[][] = [];
      for (let i = 0; i < requests.length; i += BATCH_SIZE)
        chunks.push(requests.slice(i, i + BATCH_SIZE));
      const settled = await Promise.all(
        chunks.map((chunk) =>
          batchGenerate(
            chunk.map(
              (r): BatchRequest => ({ ...callOptions(r), customId: r.id, schema: r.schema }),
            ),
            { pollIntervalMs: BATCH_POLL_MS },
          ),
        ),
      );
      return new Map(settled.flatMap(({ results }) => results.map(toAnswer)));
    },
  };
}

function callOptions(request: LocationRequest): CallOptions {
  return {
    model: "haiku",
    system: request.system,
    cacheSystem: true,
    messages: [{ role: "user", content: request.user }],
    maxOutputTokens: request.maxOutputTokens,
    effort: request.effort,
    thinking: request.thinking,
  };
}

/** A batch result as the normalizer reads it: an errored request never completed (no row, retried later);
 *  a completed one cut off or refused carries no answer. */
export function toAnswer(result: BatchResult): [string, LocationAnswer] {
  if (result.status === "errored") {
    return [result.customId, { status: "failed", reason: result.error ?? "errored" }];
  }
  if (result.stopReason !== "end_turn" && result.stopReason !== "stop_sequence") {
    return [
      result.customId,
      { status: "no-answer", reason: result.stopReason ?? "no stop reason" },
    ];
  }
  return [result.customId, { status: "answered", text: result.text }];
}
