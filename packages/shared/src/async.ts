/**
 * Shared retry/backoff for the repo's resilient fetch loops. EXTRACTED (Phase 7) from
 * `@opusfinder/sources`' run-adapter so the ingestion list-fetch and the Phase-7 discovery
 * prober share ONE definition instead of two copies. Pure + Worker-forward: global `setTimeout`,
 * `Math.random` jitter, and `Date.parse`/`Date.now` for an HTTP-date `Retry-After` — no Node-only
 * APIs, no `process.env` reads.
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
  let ms = Math.min(2000 * 2 ** attempt, MAX_BACKOFF_MS);
  if (retryAfter) {
    // Retry-After is either delta-seconds (a number) or an HTTP-date (RFC 7231 allows both).
    // `>= 0` so a `Retry-After: 0` ("retry immediately") is honored as ~0 ms; with `> 0` it would
    // fall through to Date.parse("0") (which V8 reads as the year 2000) and be silently dropped,
    // leaving the full exponential backoff. An empty header is already screened by `if (retryAfter)`.
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      ms = Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    } else {
      const until = Date.parse(retryAfter);
      if (!Number.isNaN(until)) {
        const delta = until - Date.now();
        if (delta > 0) ms = Math.min(delta, MAX_RETRY_AFTER_MS);
      }
    }
  }
  ms += Math.random() * 250; // jitter so concurrent retries don't synchronize
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve after `ms` milliseconds — the repo's one inter-request pacing primitive. Lifted here
 * (Phase 8) so the ingestion pacer (`runIngestion`) and the discovery prober's host throttle share
 * ONE definition instead of two identical copies. Pure + Worker-forward: global `setTimeout` only.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
