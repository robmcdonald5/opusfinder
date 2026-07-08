export interface AnthropicWireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicMessageOpts {
  text?: string;
  toolUse?: { name: string; input: unknown };
  stopReason?: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence";
  model?: string;
  usage?: AnthropicWireUsage;
}

/**
 * A WIRE Anthropic Messages API response (`POST /v1/messages`). Emit snake_case usage fields — the
 * @ai-sdk/anthropic layer maps `cache_creation_input_tokens` → providerMetadata.anthropic.* and
 * `cache_read_input_tokens` → usage.cachedInputTokens, which is exactly what readCacheCounters reads.
 * A fixture that emitted the SDK-normalized shape would bypass the mapping the test means to prove.
 */
export function anthropicMessage(opts: AnthropicMessageOpts = {}) {
  const content = opts.toolUse
    ? [{ type: "tool_use", id: "toolu_test", name: opts.toolUse.name, input: opts.toolUse.input }]
    : [{ type: "text", text: opts.text ?? "hello" }];
  const usage: AnthropicWireUsage = { input_tokens: 10, output_tokens: 5, ...opts.usage };
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: opts.model ?? "claude-haiku-4-5",
    content,
    stop_reason: opts.stopReason ?? (opts.toolUse ? "tool_use" : "end_turn"),
    stop_sequence: null,
    usage,
  };
}
