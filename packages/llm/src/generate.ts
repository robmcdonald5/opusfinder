import { generateText } from "ai";
import type { FinishReason, ModelMessage } from "ai";

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
   * is small: long outputs (e.g. Phase 10 synthesis) MUST raise it and should check
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
   * Anthropic prompt-cache accounting, surfaced first-class so callers (and the Phase
   * 3 test) can see caching working. Both default to 0 when the call neither wrote nor
   * read cache, or for a non-Anthropic provider.
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
 * Intentionally a minimal surface for Phase 3 (model / messages / system / cacheSystem
 * / maxOutputTokens / temperature). Tools + structured output (Phase 9), abort signals
 * and retry/backoff tuning (Phase 10) get added when a consumer needs them — until
 * then provider errors propagate unwrapped and retries are the caller's concern.
 *
 * Batch generation (50% discount, for Phase 10 rerank/synthesis) is a separate helper —
 * see {@link batchGenerate}.
 */
export async function generate(params: GenerateParams): Promise<GenerateResult> {
  const { model, messages, system, cacheSystem, maxOutputTokens, temperature } = params;

  // Contract guard: the system prompt belongs in `system`. A system message buried in
  // `messages` would land after the cache breakpoint (silently shrinking the cached
  // prefix) or, if non-leading, make the Anthropic converter throw deep in the SDK.
  // Fail clearly at the boundary instead.
  if (messages.some((m) => m.role === "system")) {
    throw new Error(
      'generate(): pass the system prompt via the `system` option, not as a role:"system" ' +
        "entry in `messages` (mixing them misplaces the prompt-cache breakpoint).",
    );
  }
  if (maxOutputTokens !== undefined && maxOutputTokens < 1) {
    throw new Error(`generate(): maxOutputTokens must be >= 1 (got ${maxOutputTokens}).`);
  }

  // A plain `system: string` can't carry a cache breakpoint. When caching the system
  // prompt, promote it to a leading system message with the Anthropic ephemeral
  // cacheControl marker; otherwise pass it through as the plain `system` field.
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

  const result = await generateText({
    model: resolveModel(model),
    system: cacheTheSystem ? undefined : system,
    messages: finalMessages,
    // The cache-marked system prompt rides as a (trusted, app-authored) system message
    // — a plain `system` string can't hold a cacheControl breakpoint. This flag is a
    // no-op on ai@5 (which allows system-in-messages by default); it's kept for
    // forward-compat with ai@7, which rejects system-in-messages without this opt-in.
    ...(cacheTheSystem ? { allowSystemInMessages: true } : {}),
    maxOutputTokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ...(temperature === undefined ? {} : { temperature }),
  });

  // Cache accounting is split across two places in AI SDK v5 + @ai-sdk/anthropic:
  // writes are Anthropic-specific (providerMetadata.anthropic.cacheCreationInputTokens);
  // reads use the normalized usage.cachedInputTokens (the provider exposes no
  // cacheReadInputTokens field).
  const anthropic = result.providerMetadata?.anthropic;
  return {
    text: result.text,
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

/**
 * providerMetadata / usage values are typed loosely (JSONValue, `number | undefined`);
 * coerce a cache counter to a finite number, defaulting to 0 when absent, null, NaN, or
 * otherwise non-numeric.
 */
function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
