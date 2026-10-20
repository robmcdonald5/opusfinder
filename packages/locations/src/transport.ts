/**
 * The production {@link LocationModel}: the location normalizer's requests over @opusfinder/llm (Claude
 * Haiku through OpenRouter). Every caller (the digest deps, the locations CLIs, eval:locations) builds the
 * model here, so the transport is wired in one place. Both paths send the same call options: the cached
 * system block, the pair as the user turn, the answer schema as structured output, low effort, no thinking.
 * This is also where a provider error is sorted into deterministic (stored as unresolved) or transient
 * (nothing stored, asked again later).
 */
import {
  collectBatchResults,
  generateObject,
  ObjectGenerationError,
  OpenRouterError,
  pollBatch,
  submitBatch,
  type BatchRequest,
  type BatchResult,
  type CallOptions,
} from "@opusfinder/llm";
import { sleep } from "@opusfinder/shared/async";

import type { LocationAnswer, LocationModel, LocationRequest } from "./model";

/** One daily request's deadline, the transport's retries included. */
const GENERATE_DEADLINE_MS = 60_000;
/** Batches take minutes to hours; poll gently. The first poll waits too: a batch read within seconds of its
 *  submit can 404. */
const BATCH_POLL_MS = 30_000;
/** Consecutive failed polls (each after the transport's own retries) before giving up on waiting. */
const MAX_FAILED_POLLS = 10;
/** Statuses that reject THIS request's content (malformed, flagged by moderation, too large): asking again
 *  gets the same. Any other provider error (auth, credits, rate limits, timeouts, server errors, an error
 *  reported after the provider accepted the request) is about the provider, not the pair. */
const REJECTED_STATUSES: ReadonlySet<number> = new Set([400, 403, 413, 422]);

export function createLocationModel(): LocationModel {
  return {
    async generate(request) {
      try {
        const { object } = await generateObject({
          ...callOptions(request),
          schema: request.schema,
          signal: AbortSignal.timeout(GENERATE_DEADLINE_MS),
        });
        return { status: "answered", text: JSON.stringify(object) };
      } catch (err) {
        return failedAnswer(err);
      }
    },
    submitBatch(requests) {
      return submitBatch(
        requests.map(
          (r): BatchRequest => ({ ...callOptions(r), customId: r.id, schema: r.schema }),
        ),
      );
    },
    async collectBatch(batchId) {
      for (let failedPolls = 0; ; ) {
        await sleep(BATCH_POLL_MS);
        try {
          if ((await pollBatch(batchId)).status === "ended") break;
          failedPolls = 0;
        } catch (err) {
          if (++failedPolls >= MAX_FAILED_POLLS) throw err;
        }
      }
      const { results } = await collectBatchResults(batchId);
      return new Map([...results.values()].map(toAnswer));
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

/**
 * A structured call that threw, as an outcome. A reply with nothing usable in it (cut off, refused,
 * off-schema after the retry) or a provider rejecting the request's content is `no-answer`; a timeout, a
 * network error or any other provider error is `failed`. Anything else (a missing key, a bug) still throws.
 * Reasons carry the error's status and type, never a message a provider wrote.
 */
export function failedAnswer(err: unknown): LocationAnswer {
  if (err instanceof ObjectGenerationError) return { status: "no-answer", reason: err.message };
  if (err instanceof OpenRouterError) {
    const reason = `OpenRouter ${err.status} ${err.type}`;
    return REJECTED_STATUSES.has(err.status)
      ? { status: "no-answer", reason }
      : { status: "failed", reason };
  }
  if (err instanceof TypeError || isAbort(err)) {
    return { status: "failed", reason: err instanceof Error ? err.name : "network error" };
  }
  throw err;
}

/** The deadline firing (TimeoutError) or a cancelled fetch (AbortError). */
function isAbort(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

/** A batch result as the normalizer reads it: an errored request is transient (no row, retried later); a
 *  completed one cut off or refused carries no answer. */
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
