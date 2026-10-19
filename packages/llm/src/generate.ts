import {
  buildMessagesBody,
  readMessage,
  toSyncBody,
  type CacheCounters,
  type CallOptions,
  type MessagesResponse,
  type StopReason,
  type Usage,
} from "./messages";
import { openRouterRequest } from "./openrouter";

export type GenerateParams = CallOptions;

export interface GenerateResult {
  /** Generated completion text (thinking blocks excluded). */
  text: string;
  /**
   * Why generation stopped, as the API reports it. Anything but `end_turn` / `stop_sequence` means the
   * text is not a complete answer: `max_tokens` is TRUNCATED at `maxOutputTokens` (thinking included),
   * `refusal` is a safety decline.
   */
  stopReason: StopReason | null;
  usage: Usage;
  /** Prompt-cache accounting; both 0 when the call neither wrote nor read the cache. */
  cache: CacheCounters;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/**
 * Single-shot text generation through OpenRouter's Anthropic-compatible Messages API. Prompt caching is
 * first-class: `cacheSystem` sends the system prompt as a cache-marked block, and the cache counters come
 * back on the result. Provider errors propagate as `OpenRouterError` after the transport's retries.
 */
export async function generate(params: GenerateParams): Promise<GenerateResult> {
  const body = buildMessagesBody("generate", params, {
    defaultMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    cacheTtl: "5m",
  });
  const res = await openRouterRequest<MessagesResponse>(
    "POST",
    "/messages",
    toSyncBody(params, body),
  );
  return readMessage(res);
}
