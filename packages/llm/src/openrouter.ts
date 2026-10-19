import { backoff } from "@opusfinder/shared/async";

import { getOpenRouterApiKey } from "./env";

/**
 * The one HTTP transport for every model call: OpenRouter's Anthropic-compatible Messages API
 * (`POST /messages`) and its Batch API (`/batches`). Plain fetch with explicit headers on purpose — the
 * Anthropic SDK client merges `ANTHROPIC_*` environment variables (custom headers, keys) into every
 * request, which must not ride along to another vendor.
 */
const BASE_URL = "https://openrouter.ai/api/v1";
const MAX_RETRIES = 2;
// Per attempt. A long CV transcription is the slowest call; a batch submit or poll is quick.
const TIMEOUT_MS = 5 * 60 * 1000;
const MESSAGE_MAX = 300;

/** A non-2xx OpenRouter reply. Carries the HTTP status, OpenRouter's error type and its message (capped),
 *  never a request or response body. */
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

/** Send one JSON request and parse the JSON reply. Network failures, 408, 429 and 5xx retry with the shared
 *  backoff (a 429's Retry-After wins); any other non-2xx throws {@link OpenRouterError}. */
export async function openRouterRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const apiKey = getOpenRouterApiKey();
  for (let attempt = 0; ; attempt++) {
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
      if (attempt < MAX_RETRIES) {
        await backoff(attempt);
        continue;
      }
      throw err;
    }
    if (!res.ok) {
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        await res.body?.cancel().catch(() => {});
        await backoff(attempt, res.headers.get("retry-after"));
        continue;
      }
      throw await toError(res);
    }
    // A body cut mid-stream is a network failure, not a bad reply: retry it like one.
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await backoff(attempt);
        continue;
      }
      throw err;
    }
    return JSON.parse(text) as T;
  }
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
