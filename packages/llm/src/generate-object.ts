import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

import {
  addUsage,
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

export interface GenerateObjectParams<T> extends CallOptions {
  /** Zod schema for the object to extract; the reply is decoded against it and validated with it. */
  schema: z.ZodType<T>;
}

export interface GenerateObjectResult<T> {
  /** The validated object (conforms to `schema`). */
  object: T;
  /** Always a natural stop: a truncated or refused reply throws {@link ObjectGenerationError} instead. */
  stopReason: StopReason | null;
  /** Summed across attempts, including one that came back off-schema and was retried. */
  usage: Usage;
  cache: CacheCounters;
}

// Larger than generate()'s 1024: a structured-profile JSON is bigger than a one-line reply.
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
// Decoding is constrained to the schema, but the constraints it can't express (number bounds, string
// lengths) are only described to the model, so a reply can still fail validation. One retry.
const MAX_ATTEMPTS = 2;

type Spent = { usage: Usage; cache: CacheCounters };

/** The model replied, but not with a usable object: truncated, refused, or off-schema after the retry.
 *  `spent` is what the failed attempts cost (zero from `parseObject`), so a caller can still count it.
 *  Provider and network errors are never this class. */
export class ObjectGenerationError extends Error {
  readonly spent: Spent;
  constructor(message: string, options?: ErrorOptions & { spent?: Spent }) {
    super(message, options);
    this.name = "ObjectGenerationError";
    this.spent = options?.spent ?? {
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      cache: { creationInputTokens: 0, readInputTokens: 0 },
    };
  }
}

/**
 * Structured generation: the {@link generate} sibling for schema-validated output. The schema goes out as
 * the native `output_config.format` (constrained decoding, no forced tool call), converted by the Anthropic
 * SDK's `zodOutputFormat`, which also moves the constraints the API can't enforce into field descriptions;
 * the reply is then validated with the same zod schema, and an off-schema reply is retried once.
 */
export async function generateObject<T>(
  params: GenerateObjectParams<T>,
): Promise<GenerateObjectResult<T>> {
  const format = zodOutputFormat(params.schema);
  const body = buildMessagesBody("generateObject", params, {
    defaultMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    cacheTtl: "5m",
    format: { type: format.type, schema: format.schema },
  });
  const request = toSyncBody(params, body);
  const totals: Spent = {
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    cache: { creationInputTokens: 0, readInputTokens: 0 },
  };
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const reply = readMessage(
      await openRouterRequest<MessagesResponse>("POST", "/messages", request),
    );
    addUsage(totals, reply);
    if (reply.stopReason === "max_tokens") {
      throw new ObjectGenerationError(
        `generateObject(): output was truncated at maxOutputTokens=${body.max_tokens}; raise the caller's ` +
          "maxOutputTokens or lower its effort.",
        { spent: totals },
      );
    }
    if (reply.stopReason !== "end_turn") {
      throw new ObjectGenerationError(
        `generateObject(): the model stopped with "${reply.stopReason ?? "none"}" instead of an answer.`,
        { spent: totals },
      );
    }
    try {
      return { object: format.parse(reply.text) as T, stopReason: reply.stopReason, ...totals };
    } catch (err) {
      lastError = err;
    }
  }
  throw new ObjectGenerationError(
    `generateObject(): the model did not return schema-valid JSON in ${MAX_ATTEMPTS} attempts.`,
    { cause: lastError, spent: totals },
  );
}

/** Parse and validate a structured reply's text against `schema` — for a batch request sent with a
 *  `schema`, whose results come back as text. Throws {@link ObjectGenerationError}. */
export function parseObject<T>(schema: z.ZodType<T>, text: string): T {
  try {
    return zodOutputFormat(schema).parse(text) as T;
  } catch (err) {
    throw new ObjectGenerationError("parseObject(): the reply is not schema-valid JSON.", {
      cause: err,
    });
  }
}
