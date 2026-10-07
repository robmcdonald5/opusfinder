/**
 * Shared retry/backoff for the repo's resilient fetch loops. Pure + Worker-forward: global
 * `setTimeout`, `Math.random` jitter, and `Date.parse`/`Date.now` for an HTTP-date `Retry-After` —
 * no Node-only APIs, no `process.env` reads.
 */

// Cap the plain exponential backoff so a high attempt count can't sleep for minutes.
const MAX_BACKOFF_MS = 15_000;
// Cap a server-dictated Retry-After so a hostile/oversized value can't stall the loop.
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Sleep before a retry: exponential backoff (2s · 2^attempt, capped at {@link MAX_BACKOFF_MS})
 * plus jitter so concurrent retries don't synchronize. When `retryAfter` is present (an HTTP
 * `Retry-After` header value) it WINS — parsed as either delta-seconds (a number) or an HTTP-date
 * (RFC 7231 allows both), each capped at {@link MAX_RETRY_AFTER_MS}. `attempt` is 0-based.
 */
export function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
  const ms = backoffDelayMs(attempt, retryAfter) + Math.random() * 250;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait {@link backoff} sleeps, before jitter: the capped Retry-After, else the capped exponential. */
export function backoffDelayMs(attempt: number, retryAfter?: string | null): number {
  const after = parseRetryAfterMs(retryAfter);
  return after !== undefined
    ? Math.min(after, MAX_RETRY_AFTER_MS)
    : Math.min(2000 * 2 ** attempt, MAX_BACKOFF_MS);
}

/**
 * A `Retry-After` header value in ms, UNCAPPED: delta-seconds (a number) or an HTTP-date (RFC 7231 allows
 * both). `undefined` when absent, unparseable, or a date already past.
 */
export function parseRetryAfterMs(retryAfter?: string | null): number | undefined {
  if (!retryAfter) return undefined; // an empty header is screened here
  // `>= 0` so a `Retry-After: 0` ("retry immediately") is honored as 0 ms; with `> 0` it would fall
  // through to Date.parse("0") (which V8 reads as the year 2000) and be silently dropped, leaving the
  // full exponential backoff.
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const delta = Date.parse(retryAfter) - Date.now();
  return delta > 0 ? delta : undefined; // NaN (unparseable) fails `> 0` too
}

/**
 * Resolve after `ms` milliseconds — the repo's one inter-request pacing primitive. Pure +
 * Worker-forward: global `setTimeout` only.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
