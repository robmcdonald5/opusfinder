import { backoff } from "@opusfinder/shared/async";

import { getOpenRouterApiKey } from "./env";

/**
 * The one HTTP transport for every model call: OpenRouter's Anthropic-compatible Messages API
 * (`POST /messages`) and its Batch API (`/batches`). Plain fetch with explicit headers on purpose — the
 * Anthropic SDK client merges `ANTHROPIC_*` environment variables (custom headers, keys) into every
 * request, which must not ride along to another vendor.
 */
const BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MAX_RETRIES = 2;
// Per attempt. A long CV transcription is the slowest call; a batch submit or poll is quick.
const TIMEOUT_MS = 5 * 60 * 1000;
const MESSAGE_MAX = 300;
// OpenRouter's `error_type`s for a failure a later attempt can clear.
const TRANSIENT_ERROR_TYPES: ReadonlySet<string> = new Set([
  "rate_limit_exceeded",
  "provider_overloaded",
  "provider_unavailable",
  "timeout",
  "server",
]);

/** A failed OpenRouter call: the HTTP status (200 for an error that arrived after the status was sent),
 *  OpenRouter's error type and its message (capped), never a request or response body. */
export class OpenRouterError extends Error {
  readonly status: number;
  readonly type: string;
  constructor(status: number, type: string, message: string) {
    super(`OpenRouter ${status} ${type}: ${message}`);
    this.name = "OpenRouterError";
    this.status = status;
    this.type = type;
  }
}

/**
 * Send one JSON request and parse the JSON reply. Network failures, 408, 429, 5xx and a transient error
 * reported inside a 200 retry with the shared backoff (a 429's Retry-After wins); any other failure throws
 * {@link OpenRouterError}. A 2xx whose body can't be read is retried only for a GET: the server already
 * acted on a POST. `maxRetries: 0` makes a POST that must not run twice (a batch submit) a single attempt.
 */
export async function openRouterRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  opts: { maxRetries?: number } = {},
): Promise<T> {
  const apiKey = getOpenRouterApiKey();
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < maxRetries;
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "opusfinder",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (canRetry) {
        await backoff(attempt);
        continue;
      }
      throw err;
    }
    if (!res.ok) {
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (retryable && canRetry) {
        await res.body?.cancel().catch(() => {});
        await backoff(attempt, res.headers.get("retry-after"));
        continue;
      }
      throw await toError(res);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (canRetry && method === "GET") {
        await backoff(attempt);
        continue;
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not the SyntaxError itself: its message quotes the reply.
      throw new OpenRouterError(res.status, "invalid_json", "the reply is not JSON");
    }
    // OpenRouter sends 200 once a provider accepts the request; a failure after that (an overload, a
    // timeout, every fallback failing) arrives as a Messages error envelope in the body.
    const envelope = errorEnvelope(parsed);
    if (envelope) {
      if (TRANSIENT_ERROR_TYPES.has(envelope.type) && canRetry) {
        await backoff(attempt);
        continue;
      }
      throw new OpenRouterError(res.status, envelope.type, envelope.message.slice(0, MESSAGE_MAX));
    }
    return parsed as T;
  }
}

/** The `{ type: "error", error: { error_type, type, message } }` envelope of a Messages reply, if `body` is
 *  one. A batch object's own `error` field (a failed batch) is not an envelope. */
function errorEnvelope(body: unknown): { type: string; message: string } | undefined {
  const b = body as {
    type?: unknown;
    error?: { error_type?: unknown; type?: unknown; message?: unknown };
  };
  if (b?.type !== "error") return undefined;
  const e = b.error;
  const type =
    (typeof e?.error_type === "string" && e.error_type) ||
    (typeof e?.type === "string" && e.type) ||
    "error";
  return { type, message: typeof e?.message === "string" ? e.message : "" };
}

async function toError(res: Response): Promise<OpenRouterError> {
  let type = "error";
  let message = res.statusText;
  try {
    // Messages errors are `{ error: { type, message } }`; Batch API errors are `{ error: { code, message } }`.
    const body = (await res.json()) as { error?: { type?: unknown; message?: unknown } };
    if (typeof body.error?.type === "string") type = body.error.type;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // not JSON: keep the status text
  }
  return new OpenRouterError(res.status, type, message.slice(0, MESSAGE_MAX));
}
