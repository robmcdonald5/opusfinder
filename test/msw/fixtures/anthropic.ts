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

export type BatchCounts = {
  processing: number;
  succeeded: number;
  errored: number;
  canceled: number;
  expired: number;
};

/**
 * A WIRE Message Batch object (create / retrieve response). `results_url` defaults to the per-id results
 * path once ended (null while in progress), matching how the SDK reaches the results stream.
 */
export function batchObject(opts: {
  id?: string;
  status?: "in_progress" | "canceling" | "ended";
  counts?: Partial<BatchCounts>;
  resultsUrl?: string | null;
} = {}) {
  const id = opts.id ?? "batch_test";
  const status = opts.status ?? "in_progress";
  return {
    id,
    type: "message_batch",
    processing_status: status,
    request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0, ...opts.counts },
    ended_at: status === "ended" ? "2026-01-01T00:00:00Z" : null,
    created_at: "2026-01-01T00:00:00Z",
    expires_at: "2026-01-02T00:00:00Z",
    results_url:
      opts.resultsUrl === undefined
        ? status === "ended"
          ? `https://api.anthropic.com/v1/messages/batches/${id}/results`
          : null
        : opts.resultsUrl,
  };
}

type BatchLineResult =
  | { type: "succeeded"; text?: string; usage?: AnthropicWireUsage }
  | { type: "errored"; errorType?: string }
  | { type: "expired" }
  | { type: "canceled" };

/** One line of the batch results JSONL: `{ custom_id, result }`. Errored lines nest the type under
 *  `error.error.type` (the real envelope) with a secret-bearing `message` a suite can assert is dropped. */
export function batchResultLine(customId: string, result: BatchLineResult): string {
  let r: unknown;
  if (result.type === "succeeded") {
    r = { type: "succeeded", message: anthropicMessage({ text: result.text ?? "ok", usage: result.usage }) };
  } else if (result.type === "errored") {
    r = {
      type: "errored",
      error: { type: "error", error: { type: result.errorType ?? "invalid_request_error", message: "secret detail" } },
    };
  } else {
    r = { type: result.type };
  }
  return JSON.stringify({ custom_id: customId, result: r });
}

/** Join result lines into a newline-delimited JSONL body (trailing newline included). */
export function jsonl(lines: string[]): string {
  return lines.join("\n") + "\n";
}
