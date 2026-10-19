/**
 * WIRE fixtures for OpenRouter: its Anthropic-compatible Messages API (`POST /api/v1/messages`) and its
 * Batch API (`/api/v1/batches`). Shapes follow live replies: Anthropic's snake_case `usage` with
 * OpenRouter's `cost` added, and batch results inline on the batch object once it completes.
 */
export const OPENROUTER_MESSAGES_URL = "https://openrouter.ai/api/v1/messages";
export const OPENROUTER_BATCHES_URL = "https://openrouter.ai/api/v1/batches";

export interface MessagesWireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cost?: number;
}

export interface MessagesReplyOpts {
  text?: string;
  /** Prepend an (empty, display-omitted) thinking block, as an adaptive-thinking reply carries. */
  thinking?: boolean;
  stopReason?: "end_turn" | "max_tokens" | "stop_sequence" | "refusal";
  usage?: MessagesWireUsage;
}

/** A Messages reply as OpenRouter returns it. */
export function messagesReply(opts: MessagesReplyOpts = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "anthropic/claude-haiku-5.5",
    provider: "Anthropic",
    content: [
      ...(opts.thinking ? [{ type: "thinking", thinking: "", signature: "sig" }] : []),
      { type: "text", text: opts.text ?? "hello" },
    ],
    stop_reason: opts.stopReason ?? "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cost: 0.0001, ...opts.usage },
  };
}

export type WireBatchState =
  | "validating"
  | "in_progress"
  | "finalizing"
  | "completed"
  | "failed"
  | "expired"
  | "cancelling"
  | "cancelled";

type WireResult = ReturnType<typeof batchSucceeded> | ReturnType<typeof batchErrored>;

/** A batch object (create / get reply). `results` and `usage` are present only when completed. */
export function batchObject(
  opts: {
    id?: string;
    status?: WireBatchState;
    counts?: { total?: number; completed?: number; failed?: number };
    results?: WireResult[];
    cost?: number;
    error?: string;
  } = {},
) {
  const status = opts.status ?? "validating";
  const completed = status === "completed";
  return {
    id: opts.id ?? "batch_test",
    object: "batch",
    endpoint: "/v1/messages",
    model: "anthropic/claude-sonnet-5.5",
    completion_window: "24h",
    status,
    created_at: 1792386816,
    finalized_at: completed ? 1792387816 : null,
    provider: "Anthropic",
    expires_at: 1792473216,
    request_counts: { total: 1, completed: 0, failed: 0, ...opts.counts },
    usage: completed
      ? { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60, cost: opts.cost ?? 0.0002 }
      : null,
    results: completed ? (opts.results ?? []) : null,
    error: opts.error ? { message: opts.error } : null,
  };
}

/** A succeeded batch result: a 200 whose body is a Messages reply. */
export function batchSucceeded(customId: string, reply: MessagesReplyOpts = {}) {
  return {
    id: `batch_req_${customId}`,
    custom_id: customId,
    response: { status_code: 200, request_id: "request_test", body: messagesReply(reply) },
    error: null,
  };
}

/** A failed batch result, with a secret-bearing `message` a suite can assert is dropped. */
export function batchErrored(customId: string, errorType = "invalid_request") {
  return {
    id: `batch_req_${customId}`,
    custom_id: customId,
    response: null,
    error: {
      type: "invalid_request_error",
      error_type: errorType,
      message: "secret detail",
      param: null,
    },
  };
}
