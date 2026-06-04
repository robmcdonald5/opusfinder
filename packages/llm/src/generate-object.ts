import { generateObject as aiGenerateObject } from "ai";
import type { FinishReason, ModelMessage } from "ai";
import type { z } from "zod";

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
   * 1024 default, since a structured-profile JSON is bigger than a one-line reply). Check
   * {@link GenerateObjectResult.finishReason} for `"length"` to detect truncation.
   */
  maxOutputTokens?: number;
  /** Sampling temperature (provider default when omitted). */
  temperature?: number;
}

export interface GenerateObjectResult<T> {
  /** The validated object (conforms to `schema`). */
  object: T;
  /** Why generation stopped. `"length"` means the JSON was TRUNCATED — raise `maxOutputTokens`. */
  finishReason: FinishReason;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** Anthropic prompt-cache accounting; both 0 when nothing was cached or for a non-Anthropic provider. */
  cache: { creationInputTokens: number; readInputTokens: number };
}

const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/**
 * Structured generation over the Vercel AI SDK + Anthropic — the {@link generate} sibling for
 * schema-validated output. Same cache plumbing and cache accounting; returns the validated object.
 *
 * Implemented over the AI SDK's STABLE `generateObject` (ai@5), NOT the experimental `Output.object`
 * path: on the pinned major `generateObject` is not deprecated while `experimental_output` is
 * experimental, so the stable call is the safer choice. This wrapper isolates the SDK surface, so a
 * future ai@6 change (if it ever deprecates `generateObject`) is a one-file edit.
 */
export async function generateObject<T>(
  params: GenerateObjectParams<T>,
): Promise<GenerateObjectResult<T>> {
  const { model, schema, messages, system, cacheSystem, maxOutputTokens, temperature } = params;

  if (messages.some((m) => m.role === "system")) {
    throw new Error(
      'generateObject(): pass the system prompt via the `system` option, not as a role:"system" ' +
        "entry in `messages` (mixing them misplaces the prompt-cache breakpoint).",
    );
  }
  if (maxOutputTokens !== undefined && maxOutputTokens < 1) {
    throw new Error(`generateObject(): maxOutputTokens must be >= 1 (got ${maxOutputTokens}).`);
  }

  // Same cache trick as generate(): a plain `system: string` can't carry a cacheControl breakpoint,
  // so when caching is requested promote it to a leading cache-marked system message.
  const cacheTheSystem = Boolean(cacheSystem && system);
  const finalMessages: ModelMessage[] = cacheTheSystem
    ? [
        {
          role: "system",
          content: system as string,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
        ...messages,
      ]
    : messages;

  const result = await aiGenerateObject({
    model: resolveModel(model),
    schema,
    system: cacheTheSystem ? undefined : system,
    messages: finalMessages,
    ...(cacheTheSystem ? { allowSystemInMessages: true } : {}),
    maxOutputTokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ...(temperature === undefined ? {} : { temperature }),
  });

  const anthropic = result.providerMetadata?.anthropic;
  return {
    object: result.object,
    finishReason: result.finishReason,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
    cache: {
      creationInputTokens: toCount(anthropic?.cacheCreationInputTokens),
      readInputTokens: toCount(result.usage.cachedInputTokens),
    },
  };
}

/** Coerce a loosely-typed cache counter to a finite number, defaulting to 0. */
function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
