import { createHash } from "node:crypto";

import type Anthropic from "@anthropic-ai/sdk";

import { modelId, type Effort, type ModelAlias, type Thinking } from "./provider";

/**
 * The Anthropic Messages request shape every call sends, built in ONE place: the sync calls post it to
 * OpenRouter's `/messages` and the batch puts it in each request's `body`, so a synthesis note and a rerank
 * score are asked for the same way.
 */

/** A PDF for a vision/transcription call (see `pdfPart`). Sync calls only: the Batch API takes files by
 *  URL, never inline bytes. */
export interface PdfPart {
  type: "pdf";
  data: Uint8Array;
}

export interface TextPart {
  type: "text";
  text: string;
}

export type ContentPart = TextPart | PdfPart;

/** One conversation turn. The system prompt is the separate `system` option, never a turn. */
export interface Message {
  role: "user" | "assistant";
  content: string | ContentPart[];
}

/** What every model call takes, sync or batched. */
export interface CallOptions {
  /** Model tier. */
  model: ModelAlias;
  /** User/assistant turns. */
  messages: Message[];
  /** Optional system prompt. */
  system?: string;
  /**
   * Mark the system prompt as a prompt-cache breakpoint. Engages only once the prefix clears the model's
   * minimum (512 tokens on both current tiers); below that the marker is silently ignored, so read the
   * returned `cache` counters rather than assume.
   */
  cacheSystem?: boolean;
  /** Output-token cap; thinking counts toward it. Each entry point has its own default. */
  maxOutputTokens?: number;
  /** See {@link Effort}. Omitted = the model's default. */
  effort?: Effort;
  /** See {@link Thinking}. Omitted = adaptive. */
  thinking?: Thinking;
}

/** Token and cost accounting for a call. `costUsd` is what OpenRouter charged (0 when it reported none). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Prompt-cache accounting: tokens written to the cache and read from it. */
export interface CacheCounters {
  creationInputTokens: number;
  readInputTokens: number;
}

export type StopReason = Anthropic.StopReason;

/** A Messages response, read: the text blocks joined (thinking blocks dropped), the stop reason, usage. */
export interface ReadMessage {
  text: string;
  stopReason: StopReason | null;
  usage: Usage;
  cache: CacheCounters;
}

type ThinkingParam = { type: "adaptive" } | { type: "disabled" } | { type: "between_tools" };

/** The wire body: Anthropic's Messages params, with `thinking` widened to the spellings the current tiers
 *  take and `model` optional (a batch request inherits the batch's model). */
export type MessagesBody = Omit<Anthropic.MessageCreateParamsNonStreaming, "model" | "thinking"> & {
  model?: string;
  thinking?: ThinkingParam;
};

/** The sync body: the Messages body plus OpenRouter's routing fields (the Batch API takes neither). */
export type SyncMessagesBody = MessagesBody & {
  provider: { require_parameters: true; data_collection: "deny" };
  session_id?: string;
};

// How each tier turns extended thinking off: Haiku 5.5 takes `disabled`; Sonnet 5.5 rejects it and takes
// `between_tools`, which the Batch API rejects.
const THINKING_OFF: Record<ModelAlias, ThinkingParam> = {
  haiku: { type: "disabled" },
  sonnet: { type: "between_tools" },
};

/** Contract guard: a positive output-token budget. */
export function assertMaxOutputTokens(fnName: string, maxOutputTokens: number | undefined): void {
  if (maxOutputTokens !== undefined && maxOutputTokens < 1) {
    throw new Error(`${fnName}(): maxOutputTokens must be >= 1 (got ${maxOutputTokens}).`);
  }
}

/** Build the Messages body for one call. `format` constrains the reply to a JSON schema; `cacheTtl` is
 *  the breakpoint lifetime (a batch outlives the 5-minute default). */
export function buildMessagesBody(
  fnName: string,
  opts: CallOptions,
  cfg: {
    defaultMaxOutputTokens: number;
    cacheTtl: "5m" | "1h";
    format?: Anthropic.JSONOutputFormat;
    inBatch?: boolean;
  },
): MessagesBody {
  assertMaxOutputTokens(fnName, opts.maxOutputTokens);
  const thinkingOff = opts.thinking === "off";
  if (thinkingOff && (opts.effort === "xhigh" || opts.effort === "max")) {
    throw new Error(
      `${fnName}(): thinking "off" needs effort "high" or below (got "${opts.effort}").`,
    );
  }
  if (thinkingOff && cfg.inBatch && opts.model === "sonnet") {
    throw new Error(
      `${fnName}(): the Batch API rejects sonnet's thinking-off setting; send effort "low" with ` +
        "adaptive thinking instead.",
    );
  }
  const outputConfig: Anthropic.OutputConfig = {
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(cfg.format ? { format: cfg.format } : {}),
  };
  return {
    max_tokens: opts.maxOutputTokens ?? cfg.defaultMaxOutputTokens,
    ...(opts.system === undefined
      ? {}
      : { system: buildSystem(opts.system, opts.cacheSystem, cfg.cacheTtl) }),
    messages: opts.messages.map((m) => ({
      role: m.role,
      content: toContent(fnName, m.content, cfg.inBatch),
    })),
    thinking: thinkingOff ? THINKING_OFF[opts.model] : { type: "adaptive" },
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
  };
}

/**
 * The sync body: the model slug and OpenRouter's routing fields. `require_parameters` routes only to a
 * provider that honors every field sent (Bedrock's Claude endpoints don't take a JSON-schema format, so a
 * structured call skips them); `data_collection: "deny"` keeps CV text away from providers that store or
 * train on it. When the system prompt is cached, a `session_id` derived from it keeps every call sharing
 * that prefix on one provider — OpenRouter's default stickiness keys on the first user message, which
 * differs per rerank chunk, so the chunks would otherwise scatter across providers' separate caches.
 */
export function toSyncBody(opts: CallOptions, body: MessagesBody): SyncMessagesBody {
  const model = modelId(opts.model);
  const sessionId =
    opts.cacheSystem && opts.system
      ? `cache-${createHash("sha256").update(`${model}\n${opts.system}`).digest("hex").slice(0, 40)}`
      : undefined;
  return {
    model,
    ...body,
    provider: { require_parameters: true, data_collection: "deny" },
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

function buildSystem(
  system: string,
  cacheSystem: boolean | undefined,
  ttl: "5m" | "1h",
): string | Anthropic.TextBlockParam[] {
  if (!cacheSystem) return system;
  return [
    {
      type: "text",
      text: system,
      cache_control: ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" },
    },
  ];
}

function toContent(
  fnName: string,
  content: string | ContentPart[],
  inBatch: boolean | undefined,
): string | Anthropic.ContentBlockParam[] {
  if (typeof content === "string") return content;
  return content.map((part): Anthropic.ContentBlockParam => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (inBatch) {
      throw new Error(
        `${fnName}(): a PDF part can't be batched (the Batch API takes files by URL only).`,
      );
    }
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: Buffer.from(part.data).toString("base64"),
      },
    };
  });
}

/** The fields this package reads off a Messages response, plus OpenRouter's `usage.cost`. */
export interface MessagesResponse {
  content?: { type: string; text?: unknown }[];
  stop_reason?: StopReason | null;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cost?: unknown;
  };
}

export function readMessage(res: MessagesResponse): ReadMessage {
  const text = (res.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  const u = res.usage ?? {};
  return {
    text,
    stopReason: res.stop_reason ?? null,
    usage: {
      inputTokens: count(u.input_tokens),
      outputTokens: count(u.output_tokens),
      costUsd: count(u.cost),
    },
    cache: {
      creationInputTokens: count(u.cache_creation_input_tokens),
      readInputTokens: count(u.cache_read_input_tokens),
    },
  };
}

/** Add one call's usage and cache counters into running totals. */
export function addUsage(
  into: { usage: Usage; cache: CacheCounters },
  from: { usage: Usage; cache: CacheCounters },
): void {
  into.usage.inputTokens += from.usage.inputTokens;
  into.usage.outputTokens += from.usage.outputTokens;
  into.usage.costUsd += from.usage.costUsd;
  into.cache.creationInputTokens += from.cache.creationInputTokens;
  into.cache.readInputTokens += from.cache.readInputTokens;
}

/** Coerce a loosely-typed counter to a finite number, defaulting to 0. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
