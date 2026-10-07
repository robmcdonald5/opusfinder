import type { NormalizedJob } from "@opusfinder/shared";
import { backoff, backoffDelayMs, parseRetryAfterMs } from "@opusfinder/shared/async";

import type { Cursor, FetchJson, JobsRequest, SourceAdapter, SourceContext } from "./types";

/**
 * The invariant ATS-ingestion plumbing. Everything that is the SAME across sources lives here;
 * everything that DIFFERS lives on the per-source `SourceAdapter` descriptor.
 *
 * runAdapter owns: slug normalization → the pagination loop (jobsRequest → fetch → locate →
 * map) → the single resilient fetch (retry/backoff/Retry-After + non-JSON guard) → two-tier
 * resilience (locate fails LOUD on a bad envelope; mapItem fails SOFT, skipping one bad
 * posting) → the optional bounded-concurrency hydrate pool → per-board accounting. Returns
 * `NormalizedJob[]` — every LISTED posting, a failed hydrate's job included but flagged
 * `contentMissing` (see the hydrate pool below).
 *
 * Worker-forward: global `fetch`/`RequestInit` only, `setTimeout`-based backoff, `Math.random`
 * jitter, no Node-only APIs and no `process.env` reads.
 */
export interface RunAdapterOptions {
  /** Max concurrent `hydrate` calls (Worker subrequest budgets may want this lower). */
  hydrateConcurrency?: number;
  /** Max retry attempts on a transient failure (429 / 5xx / network throw). */
  maxRetries?: number;
  /**
   * Per-request fetch timeout (ms). The global `fetch` has NO default timeout, so a board
   * endpoint that accepts the connection but never sends a response would hang the bare `await
   * fetch(...)` FOREVER — stalling the whole ingestion run until the Cloudflare Worker is
   * wall-clock-killed before `finishRun`. Because the KV chunk cursor only advances on a clean
   * return (`apps/scrapers/src/index.ts`), a killed run never advances it, so the next tick
   * re-pins the SAME poison chunk and hangs again — a stuck loop that never self-heals. An
   * `AbortSignal.timeout` converts that hang into an ordinary transient failure: it is retried
   * like a network throw, then (if still failing) fails THAT board in isolation, so the run
   * completes and the cursor moves past the chunk. Defaults to {@link DEFAULT_FETCH_TIMEOUT_MS}.
   */
  fetchTimeoutMs?: number;
  /**
   * Cap the postings PROCESSED for one board (Worker-only). Stops PAGINATION once this many valid
   * postings are mapped, so the list-fetch count, the N+1 hydrate pool, AND the in-memory array are all
   * bounded — a pathological mega-board (SmartRecruiters boschgroup ~4.6k postings) otherwise consumes
   * the whole Worker invocation's wall-clock / memory / subrequest budget and kills the tick before
   * `finishRun`, freezing the chunk cursor. Omit ⇒ no cap (the CLI, in Node, has no per-invocation budget
   * and ingests the whole board). A capped board is a PARTIAL fetch: runIngestion skips its feed-absence
   * sweep (an incomplete present-set would false-close the un-fetched tail).
   */
  maxItems?: number;
  /**
   * Fail fast (Worker-only): no retry ever waits longer than this (+ jitter); a retry that would — its
   * Retry-After or its backoff — is not made, and the request fails with its own error. Only a 429 throws
   * {@link RateLimitedError}. A request is 429'd at most once: any failure after its 429 (a timeout, a reset,
   * a bad body, a 5xx, a 403, another 429) ends it as a RateLimitedError at once — except a definitive
   * 404/410, which keeps its own error. The hydrate pool stops at the first RateLimitedError. Omit ⇒ today's
   * patient behaviour: sleep every Retry-After (capped at 30 s) — the CLI.
   */
  maxRetryWaitMs?: number;
  /**
   * Per-board time limit (Worker-only): once a board has run this long, no new request starts for it — its
   * list fetch fails the board; a detail fetch leaves its posting `contentMissing` (stored content kept).
   * Requests already in flight finish under their own `fetchTimeoutMs`. Omit ⇒ unlimited (the CLI).
   */
  boardTimeLimitMs?: number;
}

/**
 * The host answered a request 429 (fail-fast mode only — see `maxRetryWaitMs`). `retryAfterMs` is its
 * Retry-After, uncapped, or {@link RATE_LIMIT_MIN_COOLDOWN_MS} when it sent none usable: how long the caller
 * should leave that host alone. Shape-only message: the tag and the wait.
 */
export class RateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(tag: string, retryAfterMs: number, options?: ErrorOptions) {
    super(`${tag} rate-limited: 429, retry after ${Math.ceil(retryAfterMs / 1000)}s`, options);
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

const DEFAULT_HYDRATE_CONCURRENCY = 5;
const DEFAULT_MAX_RETRIES = 3;
// Generous for a healthy ATS JSON endpoint, but well under the Worker wall limit so one hung
// board (worst case ~maxRetries attempts + backoff) can't eat the whole tick's budget.
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
/** The least a rate limit sidelines its host: the wait assumed when a 429 carries no usable Retry-After,
 *  and runIngestion's cooldown floor (a 429 that outlasted a short retry means the host still throttles). */
export const RATE_LIMIT_MIN_COOLDOWN_MS = 60_000;

export async function runAdapter(
  adapter: SourceAdapter,
  rawSlug: string,
  opts: RunAdapterOptions = {},
): Promise<NormalizedJob[]> {
  return (await fetchBoard(adapter, rawSlug, opts)).jobs;
}

/**
 * {@link runAdapter}, plus `rateLimited`: the RateLimitedError a hydrate (detail) fetch hit, if any. The
 * board itself still succeeds, so this is how runIngestion learns to cool that host down. Package-internal.
 */
export async function fetchBoard(
  adapter: SourceAdapter,
  rawSlug: string,
  opts: RunAdapterOptions = {},
): Promise<{ jobs: NormalizedJob[]; rateLimited?: RateLimitedError }> {
  const hydrateConcurrency = opts.hydrateConcurrency ?? DEFAULT_HYDRATE_CONCURRENCY;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxItems = opts.maxItems;

  const deadline = opts.boardTimeLimitMs === undefined ? undefined : Date.now() + opts.boardTimeLimitMs;
  const ctx: SourceContext = { slug: adapter.normalizeSlug(rawSlug), rawSlug };
  const tag = `${adapter.source} "${ctx.slug}"`;
  const fetchJson: FetchJson = (req) =>
    fetchJsonResilient(req, tag, maxRetries, fetchTimeoutMs, opts.maxRetryWaitMs, deadline);

  // Pagination loop. Keep each raw list item beside its mapped job ONLY when there is a hydrate to
  // hand it to (the job itself carries no raw — it is not stored); otherwise drop the reference so a
  // multi-page board doesn't pin every parsed page until the loop ends.
  const hydrate = adapter.hydrate;
  const mapped: { raw: unknown; job: NormalizedJob }[] = [];
  let skipped = 0;
  let cursor: Cursor | null = null;
  for (;;) {
    const body = await fetchJson(adapter.jobsRequest(ctx, cursor));
    const items = adapter.locate(body, ctx); // fail LOUD: a bad envelope is a real regression
    for (const raw of items) {
      // fail SOFT: a null return OR a thrown error (e.g. a branding-floor violation such as
      // an id with internal whitespace) skips + counts one posting, never aborts the board.
      let job: NormalizedJob | null;
      try {
        job = adapter.mapItem(raw, ctx);
      } catch {
        job = null;
      }
      if (job) {
        // Canonical location order: keeps the in-memory job identical to what upsertJobs
        // persists, and keeps its order-sensitive jsonb compare from churning on a reorder.
        job.locations = [...job.locations].sort();
        mapped.push({ raw: hydrate ? raw : undefined, job });
      } else {
        skipped++;
      }
    }
    // Per-board cap — see RunAdapterOptions.maxItems.
    if (maxItems !== undefined && mapped.length >= maxItems) {
      mapped.length = maxItems;
      break;
    }
    if (!adapter.nextCursor) break; // omitted ⇒ single unpaginated fetch
    const next = adapter.nextCursor(body, cursor, items.length);
    if (!next) break;
    cursor = next;
  }

  // Optional hydrate (N+1 second fetch) through a bounded-concurrency pool, each call handed its own
  // list item. A per-item failure — ANY failed or empty detail fetch (retries exhausted, a timeout, a
  // 404/410, a body with no content; the adapter throws) — keeps the listed job, because it WAS listed and
  // so is live: ingestion must still count it present. But its description is mapItem's placeholder "",
  // not the posting's text, so it is flagged `contentMissing` and upsertJobs never writes its content —
  // persisted, it would overwrite the stored description, NULL the embedding (a paid re-embed) and flip
  // content_signature, then flip it all back on the next good hydrate.
  let jobs: NormalizedJob[];
  let unhydrated = 0;
  let rateLimited: RateLimitedError | undefined;
  if (hydrate) {
    // After the first rate-limited detail fetch the rest skip theirs (contentMissing, no request) rather
    // than each hitting a host that is throttling us.
    jobs = await mapWithConcurrency(mapped, hydrateConcurrency, async ({ raw, job }) => {
      if (!rateLimited) {
        try {
          return { ...job, ...(await hydrate(job, raw, ctx, fetchJson)) };
        } catch (err) {
          if (err instanceof RateLimitedError) rateLimited ??= err;
        }
      }
      unhydrated++;
      return { ...job, contentMissing: true as const };
    });
  } else {
    jobs = mapped.map((m) => m.job);
  }

  if (skipped > 0 || unhydrated > 0) {
    console.warn(
      `${tag}: ${jobs.length} job(s)` +
        (skipped > 0 ? `, skipped ${skipped} malformed` : "") +
        (unhydrated > 0 ? `, ${unhydrated} un-hydrated (content missing, not written)` : ""),
    );
  }
  return { jobs, rateLimited };
}

/**
 * Fetch one request and parse JSON, retrying transient failures with exponential backoff +
 * jitter (honoring `Retry-After`). The single resilient fetch path in the package:
 * - `!res.ok` → drain the body, then retry on 429/5xx or throw a tagged error.
 * - fail-fast mode (`maxRetryWaitMs` set): see {@link RunAdapterOptions.maxRetryWaitMs}.
 * - guard non-JSON bodies (e.g. Workable's HTML 429 / text 404) by catching the parse into
 *   the tagged error rather than surfacing a raw SyntaxError.
 */
async function fetchJsonResilient(
  req: JobsRequest,
  tag: string,
  maxRetries: number,
  timeoutMs: number,
  maxRetryWaitMs?: number,
  deadline?: number,
): Promise<unknown> {
  let attempt = 0;
  // Fail-fast mode only: the Retry-After of this request's 429. Once set, the request's next failure ends it.
  let limitedRetryAfterMs: number | undefined;
  // Back off and retry — unless out of attempts or (fail-fast) the wait would exceed maxRetryWaitMs.
  const retry = async (retryAfter?: string | null): Promise<boolean> => {
    if (attempt >= maxRetries) return false;
    const wait = parseRetryAfterMs(retryAfter) ?? backoffDelayMs(attempt);
    if (maxRetryWaitMs !== undefined && wait > maxRetryWaitMs) return false;
    await backoff(attempt++, retryAfter);
    return true;
  };
  // The error a failed request ends with: a RateLimitedError once it has been 429'd, else its own.
  const fail = (err: Error): Error =>
    limitedRetryAfterMs === undefined
      ? err
      : new RateLimitedError(tag, limitedRetryAfterMs, { cause: err });
  for (;;) {
    // The board's time limit: no new attempt once it is spent (see RunAdapterOptions.boardTimeLimitMs).
    if (deadline !== undefined && Date.now() >= deadline) throw new Error(`${tag} board time limit reached`);
    let res: Response;
    try {
      // Bound every attempt with a fresh timeout signal (the abort throws -> the catch below
      // retries it like any transient network failure). Merge — never clobber — an adapter's
      // own signal on the off chance a future adapter sets one.
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = req.init?.signal ? AbortSignal.any([req.init.signal, timeout]) : timeout;
      res = await fetch(req.url, { ...req.init, signal });
    } catch (err) {
      if (limitedRetryAfterMs === undefined && (await retry())) continue;
      throw fail(
        new Error(`${tag} fetch error: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        }),
      );
    }

    if (res.ok) {
      const text = await res.text();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // A truncated/empty body on a 2xx is usually transient (a proxy cutting a large
        // response mid-stream, an edge hiccup) — retry like a 5xx rather than hard-failing
        // the whole board on the first bad read.
        if (limitedRetryAfterMs === undefined && (await retry())) continue;
        throw fail(new Error(`${tag} returned a non-JSON body (status ${res.status})`));
      }
    }

    // Non-OK: release the (possibly HTML/text) body so no socket lingers, then retry or fail.
    const retryAfter = res.headers.get("retry-after");
    await res.body?.cancel().catch(() => {});
    const error = new Error(`${tag} fetch failed: ${res.status} ${res.statusText}`);
    // A definitive 404/410 is its own answer, even after a 429. Any other 4xx isn't retried either, but after
    // a 429 it still reports the rate limit (a WAF's 403, say).
    if (res.status === 404 || res.status === 410) throw error;
    if (res.status !== 429 && res.status < 500) throw fail(error);
    const wasLimited = limitedRetryAfterMs !== undefined;
    if (res.status === 429 && maxRetryWaitMs !== undefined) {
      limitedRetryAfterMs = parseRetryAfterMs(retryAfter) ?? RATE_LIMIT_MIN_COOLDOWN_MS;
    }
    // A request already 429'd ends at this failure; otherwise retry (within maxRetryWaitMs, in fail-fast).
    if (!wasLimited && (await retry(retryAfter))) continue;
    throw fail(error);
  }
}

/** Run up to `limit` async tasks concurrently, preserving input order in the result. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  const workers = Math.min(Math.max(limit, 1), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
