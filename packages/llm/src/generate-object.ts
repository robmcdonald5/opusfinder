import { generateObject as aiGenerateObject, NoObjectGeneratedError } from "ai";
import type { FinishReason, ModelMessage } from "ai";
import type { z } from "zod";

import {
  assertMaxOutputTokens,
  assertSystemNotInMessages,
  buildCacheableRequest,
  readCacheCounters,
} from "./cache-plumbing";
import { resolveModel, type ModelAlias } from "./provider";

export interface GenerateObjectParams<T> {
  /** Model tier. */
  model: ModelAlias;
  /** Zod schema for the object to extract; the result is validated against it. */
  schema: z.ZodType<T>;
  /**
   * User/assistant turns. The system prompt goes in `system`, NOT here (same rule + rationale as
   * {@link generate}: a role:"system" entry in `messages` misplaces the cache breakpoint).
   */
  messages: ModelMessage[];
  /** Optional system prompt. Pass it here, never as a message in `messages`. */
  system?: string;
  /**
   * Mark the system prompt as an Anthropic ephemeral cache breakpoint (same mechanism as
   * {@link generate}'s `cacheSystem`). Only engages above the model's minimum cacheable prefix
   * (Haiku ~4096 tokens); below that it is silently a no-op. Verify via the returned `cache` counters.
   */
  cacheSystem?: boolean;
  /**
   * Max tokens to generate. Defaults to {@link DEFAULT_MAX_OUTPUT_TOKENS} (larger than `generate`'s
   * 1024 default, since a structured-profile JSON is bigger than a one-line reply). If the model hits
   * this mid-JSON the SDK can't parse the output — see the truncation note on {@link generateObject}.
   */
  maxOutputTokens?: number;
  /** Sampling temperature (provider default when omitted). */
  temperature?: number;
}

export interface GenerateObjectResult<T> {
  /** The validated object (conforms to `schema`). */
  object: T;
  /**
   * Why generation stopped, for a SUCCESSFUL parse. NOTE: unlike {@link generate}, a truncated or
   * otherwise unparseable response does NOT arrive here — the AI SDK throws first (translated to a
   * {@link StructuredOutputError}). So this is `"length"` only in the rare case a length-stopped output
   * still parsed and validated.
   */
  finishReason: FinishReason;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** Anthropic prompt-cache accounting; both 0 when nothing was cached or for a non-Anthropic provider. */
  cache: { creationInputTokens: number; readInputTokens: number };
}

/**
 * Thrown when the model's output can't be parsed/validated into the schema — most often because it
 * was TRUNCATED at `maxOutputTokens` (the SDK fails to parse the partial JSON). Wraps the SDK's
 * `NoObjectGeneratedError` (kept as `cause`) with an actionable message + the `finishReason`, so a
 * caller (the 9e pipeline) can react ("raise maxOutputTokens") instead of seeing an opaque SDK throw.
 */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly finishReason: FinishReason | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StructuredOutputError";
  }
}

const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/**
 * Structured generation over the Vercel AI SDK + Anthropic — the {@link generate} sibling for
 * schema-validated output. Same cache plumbing and cache accounting; returns the validated object.
 *
 * Implemented over the AI SDK's STABLE `generateObject` (ai@5), NOT the experimental `Output.object`
 * path: on the pinned major `generateObject` is not deprecated while `experimental_output` is
 * experimental, so the stable call is the safer choice. This wrapper isolates the SDK surface.
 *
 * TRUNCATION: the SDK's generateObject THROWS `NoObjectGeneratedError` when the output can't be
 * parsed/validated (the usual symptom of hitting `maxOutputTokens` mid-JSON) — it does NOT return
 * `finishReason: "length"`. We translate that into a {@link StructuredOutputError} with an actionable
 * message; other provider errors propagate unwrapped (same posture as {@link generate}).
 */
export async function generateObject<T>(
  params: GenerateObjectParams<T>,
): Promise<GenerateObjectResult<T>> {
  const { model, schema, messages, system, cacheSystem, maxOutputTokens, temperature } = params;

  assertSystemNotInMessages("generateObject", messages);
  assertMaxOutputTokens("generateObject", maxOutputTokens);
  const effectiveMax = maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const req = buildCacheableRequest({ system, cacheSystem, messages });

  const result = await aiGenerateObject({
    model: resolveModel(model),
    schema,
    system: req.system,
    messages: req.messages,
    ...req.extra,
    maxOutputTokens: effectiveMax,
    ...(temperature === undefined ? {} : { temperature }),
  }).catch((err: unknown) => {
    if (NoObjectGeneratedError.isInstance(err)) {
      const fr = err.finishReason;
      const why =
        fr === "length"
          ? `output was truncated at maxOutputTokens=${effectiveMax}; raise maxOutputTokens`
          : `the model did not return schema-valid JSON (finishReason=${fr ?? "unknown"})`;
      throw new StructuredOutputError(`generateObject(): ${why}.`, fr, { cause: err });
    }
    throw err;
  });

  return {
    object: result.object,
    finishReason: result.finishReason,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
    cache: readCacheCounters(result),
  };
}
