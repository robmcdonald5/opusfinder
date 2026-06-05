import type { ModelMessage } from "ai";

/**
 * Shared Anthropic prompt-cache plumbing for {@link generate} and {@link generateObject} (and the
 * param contract `batchGenerate` mirrors). Extracted in Phase 9d once a third surface needed the same
 * system-message guard, cache-promotion trick, and cache accounting — so a future fix (e.g. an ai@7
 * `allowSystemInMessages` change, or a renamed provider cache field) lives in ONE place.
 */

/**
 * Contract guard: the system prompt belongs in the `system` option, not buried in `messages`. A
 * `role:"system"` entry there would land after the cache breakpoint (silently shrinking the cached
 * prefix) or, if non-leading, make the Anthropic converter throw deep in the SDK. Fail at the boundary.
 */
export function assertSystemNotInMessages(fnName: string, messages: ModelMessage[]): void {
  if (messages.some((m) => m.role === "system")) {
    throw new Error(
      `${fnName}(): pass the system prompt via the \`system\` option, not as a role:"system" ` +
        "entry in `messages` (mixing them misplaces the prompt-cache breakpoint).",
    );
  }
}

/** Contract guard: a positive output-token budget. */
export function assertMaxOutputTokens(fnName: string, maxOutputTokens: number | undefined): void {
  if (maxOutputTokens !== undefined && maxOutputTokens < 1) {
    throw new Error(`${fnName}(): maxOutputTokens must be >= 1 (got ${maxOutputTokens}).`);
  }
}

/** The SDK-call fields for an optionally-cached system prompt, ready to spread into generateText /
 *  generateObject. `extra` carries `allowSystemInMessages` only when the system prompt was promoted. */
export interface CacheableRequest {
  system: string | undefined;
  messages: ModelMessage[];
  extra: { allowSystemInMessages: true } | Record<string, never>;
}

/**
 * Build the request fields for an optionally-cached system prompt. A plain `system: string` can't
 * carry a cacheControl breakpoint, so when caching is requested we promote it to a leading
 * cache-marked system message + `allowSystemInMessages` (the flag is a no-op on ai@5, which allows
 * system-in-messages by default; kept for ai@7 forward-compat). Otherwise the plain `system` passes through.
 */
export function buildCacheableRequest(opts: {
  system?: string;
  cacheSystem?: boolean;
  messages: ModelMessage[];
}): CacheableRequest {
  const cacheTheSystem = Boolean(opts.cacheSystem && opts.system);
  if (!cacheTheSystem) {
    return { system: opts.system, messages: opts.messages, extra: {} };
  }
  return {
    system: undefined,
    messages: [
      {
        role: "system",
        content: opts.system as string,
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
      ...opts.messages,
    ],
    extra: { allowSystemInMessages: true },
  };
}

/**
 * Normalize Anthropic prompt-cache counters off an SDK result. Accounting is split across two places
 * in AI SDK v5: writes are Anthropic-specific (providerMetadata.anthropic.cacheCreationInputTokens);
 * reads use the normalized usage.cachedInputTokens (the provider exposes no cacheReadInputTokens).
 * Both default to 0 when nothing was cached or for a non-Anthropic provider.
 */
export function readCacheCounters(result: {
  providerMetadata?: unknown;
  usage: { cachedInputTokens?: number };
}): { creationInputTokens: number; readInputTokens: number } {
  const anthropic = (result.providerMetadata as { anthropic?: { cacheCreationInputTokens?: unknown } } | undefined)
    ?.anthropic;
  return {
    creationInputTokens: toCount(anthropic?.cacheCreationInputTokens),
    readInputTokens: toCount(result.usage.cachedInputTokens),
  };
}

/** Coerce a loosely-typed cache counter to a finite number, defaulting to 0. */
function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
