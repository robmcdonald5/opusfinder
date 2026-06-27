import { generateText } from "ai";
import type { FinishReason, ModelMessage } from "ai";

import {
  assertMaxOutputTokens,
  assertSystemNotInMessages,
  buildCacheableRequest,
  readCacheCounters,
} from "./cache-plumbing";
import { resolveModel, type ModelAlias } from "./provider";

export type { ModelAlias };

export interface GenerateParams {
  /** Model tier. */
  model: ModelAlias;
  /**
   * User/assistant conversation turns (Vercel AI SDK `ModelMessage` shapes). The
   * system prompt goes in `system`, NOT here — a `role: "system"` entry in `messages`
   * is rejected, since it would misplace the prompt-cache breakpoint and can trip a
   * provider error.
   */
  messages: ModelMessage[];
  /** Optional system prompt. Pass it here, never as a message in `messages`. */
  system?: string;
  /**
   * Mark the system prompt as an Anthropic ephemeral cache breakpoint. Only takes
   * effect when `system` is set AND clears the model's minimum cacheable prefix (a few
   * thousand tokens, model-dependent — highest for the Haiku 4.x tier); below that,
   * Anthropic silently skips caching. Verify it engaged via the returned `cache`
   * counters rather than assuming.
   */
  cacheSystem?: boolean;
  /**
   * Max tokens to generate. Defaults to {@link DEFAULT_MAX_OUTPUT_TOKENS}. The default
   * is small: long outputs MUST raise it and should check
   * {@link GenerateResult.finishReason} for `"length"` to detect truncation.
   */
  maxOutputTokens?: number;
  /** Sampling temperature (provider default when omitted). */
  temperature?: number;
}

export interface GenerateResult {
  /** Generated completion text. */
  text: string;
  /**
   * Why generation stopped. `"length"` means the output hit `maxOutputTokens` and is
   * TRUNCATED — raise the limit or handle the partial output; do not treat it as
   * complete.
   */
  finishReason: FinishReason;
  /** Token usage for the call. */
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /**
   * Anthropic prompt-cache accounting, surfaced first-class so callers can see caching
   * working. Both default to 0 when the call neither wrote nor read cache, or for a
   * non-Anthropic provider.
   */
  cache: { creationInputTokens: number; readInputTokens: number };
}

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/**
 * Single-shot generation over the Vercel AI SDK + Anthropic. Wraps `generateText` to
 * make prompt caching first-class: when `cacheSystem` is true the system prompt is sent
 * as a cache-marked system message (a plain `system` string cannot carry a cache
 * breakpoint), and the Anthropic cache token counts are normalized onto the result.
 *
 * Provider errors propagate unwrapped; retries are the caller's concern.
 */
export async function generate(params: GenerateParams): Promise<GenerateResult> {
  const { model, messages, system, cacheSystem, maxOutputTokens, temperature } = params;

  // Guards, cache-promotion, and cache accounting are shared with generateObject — see ./cache-plumbing.
  assertSystemNotInMessages("generate", messages);
  assertMaxOutputTokens("generate", maxOutputTokens);

  const req = buildCacheableRequest({ system, cacheSystem, messages });
  const result = await generateText({
    model: resolveModel(model),
    system: req.system,
    messages: req.messages,
    ...req.extra,
    maxOutputTokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ...(temperature === undefined ? {} : { temperature }),
  });

  return {
    text: result.text,
    finishReason: result.finishReason,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
    cache: readCacheCounters(result),
  };
}
