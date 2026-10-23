import type { NormalizedJob } from "@opusfinder/shared";
import { backoff, backoffDelayMs, parseRetryAfterMs } from "@opusfinder/shared/async";

import {
  BodyReadError,
  ListingShapeError,
  MalformedBodyError,
  readListingPage,
} from "./listing-stream";
import type { Cursor, FetchJson, JobsRequest, SourceAdapter, SourceContext } from "./types";

/**
 * The invariant ATS-ingestion plumbing. Everything that is the SAME across sources lives here;
 * everything that DIFFERS lives on the per-source `SourceAdapter` descriptor.
 *
 * fetchBoard owns: slug normalization → the pagination loop (jobsRequest → fetch → stream the page's
 * postings out of `itemsKey` → map) → the single resilient fetch (retry/backoff/Retry-After + non-JSON
 * guard) → two-tier resilience (a page without its postings array fails LOUD; mapItem fails SOFT,
 * skipping one bad posting) → the optional bounded-concurrency hydrate pool → per-board accounting. It
 * hands every LISTED posting to a sink {@link SINK_PAGE_SIZE} at a time, a failed hydrate's job included
 * but flagged `contentMissing` (see the hydrate pool below), so a board's size costs time, not memory.
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
   * How long a request may wait (ms) for its response head, and then for each chunk of its body. The
   * global `fetch` has NO default timeout, so a board endpoint that accepts the connection but never sends
   * a response would hang the bare `await fetch(...)` FOREVER — stalling the whole ingestion run until the
   * Cloudflare Worker is wall-clock-killed before `finishRun`. Because the KV chunk cursor only advances
   * on a clean return (`apps/scrapers/src/index.ts`), a killed run never advances it, so the next tick
   * re-pins the SAME poison chunk and hangs again. The timeout converts that hang into an ordinary
   * transient failure: it is retried like a network throw, then (if still failing) fails THAT board in
   * isolation, so the run completes and the cursor moves past the chunk. It never runs while the sink
   * writes a page: a big board's body may take as long as its pages take to write, as long as it keeps
   * arriving. Defaults to {@link DEFAULT_FETCH_TIMEOUT_MS}.
   */
  fetchTimeoutMs?: number;
  /**
   * Cap the postings PROCESSED for one board (Worker-only). Once this many valid postings are mapped it
   * stops PAGINATION and trims what the N+1 hydrate pool would fetch — a pathological mega-board
   * (SmartRecruiters boschgroup ~4.6k postings) otherwise consumes the whole Worker invocation's wall-clock /
   * subrequest budget and kills the tick before `finishRun`, freezing the chunk cursor. A page already
   * fetched is never trimmed when nothing would be hydrated (that would save nothing), so an unpaginated,
   * non-hydrating board is never capped: it streams through the sink a page at a time, so its size costs
   * time, not memory. Omit ⇒ no cap (the CLI, in Node, has no per-invocation budget and ingests the whole
   * board). A capped board is a PARTIAL fetch (`capped`): runIngestion skips its feed-absence sweep (an
   * incomplete present-set would false-close the un-fetched tail).
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
   * Per-board time limit (Worker-only): once a board has run this long, no new request starts for it and
   * a listing body still streaming stops at its next chunk — its list fetch fails the board; a detail fetch
   * leaves its posting `contentMissing` (stored content kept). Requests already in flight finish under
   * their own `fetchTimeoutMs`. Omit ⇒ unlimited (the CLI).
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
/**
 * Postings handed to the sink at a time. The sink (runIngestion's upsert) holds one page and its INSERT
 * at once, about 2× the page's text, so this — not the board — bounds a board's memory: ~7 MB for 200 of
 * the 2026-10-22 Anduril board's long postings.
 */
export const SINK_PAGE_SIZE = 200;
/**
 * The largest body read whole: a hydrate's detail fetch (one posting), the only response not streamed.
 * Parsing holds the text and its parsed copy at once, 4–5× the body in heap (measured), and the hydrate
 * pool runs `hydrateConcurrency` (5) at a time, so 2 MiB keeps the pool near 50 MiB at worst inside the
 * Worker's 128 MiB isolate. A bigger detail fails its posting (`contentMissing`) instead of the isolate.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** The least a rate limit sidelines its host: the wait assumed when a 429 carries no usable Retry-After,
 *  and runIngestion's cooldown floor (a 429 that outlasted a short retry means the host still throttles). */
export const RATE_LIMIT_MIN_COOLDOWN_MS = 60_000;

/** Receives a board's listed postings a page at a time, in listing order. A throw fails the board. */
export type JobSink = (jobs: NormalizedJob[]) => Promise<void>;

/** Every listed posting of one board, collected — the single-board CLI's view (no per-run budget). */
export async function runAdapter(
  adapter: SourceAdapter,
  rawSlug: string,
  opts: RunAdapterOptions = {},
): Promise<NormalizedJob[]> {
  const jobs: NormalizedJob[] = [];
  await fetchBoard(
    adapter,
    rawSlug,
    async (page) => {
      jobs.push(...page);
    },
    opts,
  );
  return jobs;
}

/** One board's fetch, as {@link fetchBoard} returns it once every page reached the sink. */
export interface BoardFetch {
  /** Every distinct external id the sink was handed, a failed hydrate's included: the board's listing. */
  listedIds: string[];
  /** Listed postings the sink got only as `contentMissing` (no copy with content): failed hydrates. */
  contentMissing: number;
  /** The RateLimitedError a hydrate (detail) fetch hit, if any. The board itself still succeeds, so this is
   *  how runIngestion learns to cool that host down. */
  rateLimited?: RateLimitedError;
  /** `maxItems` cut the fetch short: the listing is partial. */
  capped: boolean;
  /** The listing came back incomplete though no cap stopped it — a page repeated earlier ones (the server
   *  ignoring the offset; the loop stops there), or it ended well short of the adapter's `reportedTotal`. */
  partial: boolean;
  /** Listed postings `mapItem` rejected (malformed), so never handed to the sink. */
  mapSkipped: number;
  /** The board lists no postings at all, and its adapter trusts that answer: its `classifyProbe` would call
   *  it `live-empty` (the default). SmartRecruiters' 200 + totalFound:0 is also what an unknown slug gets. */
  empty: boolean;
}

/**
 * Fetch one board, handing its postings to `sink` {@link SINK_PAGE_SIZE} at a time. Package-internal.
 * A throw (a failed list fetch, a bad envelope, the sink's own failure) fails the board; pages the sink
 * already took stay taken.
 */
export async function fetchBoard(
  adapter: SourceAdapter,
  rawSlug: string,
  sink: JobSink,
  opts: RunAdapterOptions = {},
): Promise<BoardFetch> {
  const hydrateConcurrency = opts.hydrateConcurrency ?? DEFAULT_HYDRATE_CONCURRENCY;
  const maxItems = opts.maxItems;

  const ctx: SourceContext = { slug: adapter.normalizeSlug(rawSlug), rawSlug };
  const policy: RequestPolicy = {
    tag: `${adapter.source} "${ctx.slug}"`,
    maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
    timeoutMs: opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    maxRetryWaitMs: opts.maxRetryWaitMs,
    deadline: opts.boardTimeLimitMs === undefined ? undefined : Date.now() + opts.boardTimeLimitMs,
  };
  const fetchJson: FetchJson = (req) => requestResilient(req, policy, readJson);

  // What the sink was handed: the listing, and the postings it has so far seen only without content (a
  // copy WITH content always wins, in either order, as in upsertJobs).
  const listedIds = new Set<string>();
  const withContent = new Set<string>();
  const missing = new Set<string>();
  const handOver = async (jobs: NormalizedJob[]): Promise<void> => {
    for (const job of jobs) {
      listedIds.add(job.externalId);
      if (!job.contentMissing) {
        withContent.add(job.externalId);
        missing.delete(job.externalId);
      } else if (!withContent.has(job.externalId)) {
        missing.add(job.externalId);
      }
    }
    await sink(jobs);
  };

  const hydrate = adapter.hydrate;
  // A hydrating adapter's listing, held whole (a listing carries no descriptions) and hydrated after the
  // loop; a non-hydrating adapter's mapped postings waiting for a full sink page.
  const listing: NormalizedJob[] = [];
  let pending: NormalizedJob[] = [];
  const flush = async (all: boolean): Promise<void> => {
    while (pending.length >= SINK_PAGE_SIZE || (all && pending.length > 0)) {
      const page = pending.slice(0, SINK_PAGE_SIZE);
      pending = pending.slice(SINK_PAGE_SIZE);
      await handOver(page);
    }
  };

  let mapped = 0;
  let skipped = 0;
  let capped = false;
  let empty = false;
  let cursor: Cursor | null = null;
  const seenIds = new Set<string>();
  let listed = 0; // raw items over all pages, malformed ones included
  let total: number | undefined;
  let partial = false;
  for (;;) {
    const mappedBefore = mapped;
    const seenBefore = seenIds.size;
    // This request's postings. They join the board when the request completes, or early once a sink page
    // fills — from then on a failed body can't be retried, since part of it is already written. Until
    // then a retried request starts over from nothing.
    let local: NormalizedJob[] = [];
    let pageItems = 0;
    let pageSkipped = 0;
    let committed = false;
    const commit = async (): Promise<void> => {
      mapped += local.length;
      for (const job of local) seenIds.add(job.externalId);
      if (hydrate) listing.push(...local);
      else pending.push(...local);
      local = [];
      if (!hydrate) await flush(false);
    };

    const page: unknown = await requestResilient<unknown>(
      adapter.jobsRequest(ctx, cursor),
      policy,
      (res, watchdog) => {
        local = [];
        pageItems = 0;
        pageSkipped = 0;
        return readListingPage(
          res.body,
          adapter,
          async (items) => {
            pageItems += items.length;
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
                local.push(job);
              } else {
                pageSkipped++;
              }
            }
            if (local.length >= SINK_PAGE_SIZE) {
              committed = true;
              await commit();
            }
          },
          watchdog.read,
        );
      },
      () => !committed,
    );
    await commit();
    listed += pageItems;
    skipped += pageSkipped;
    total = adapter.reportedTotal?.(page) ?? total;
    if (cursor === null && pageItems === 0) {
      empty = (adapter.classifyProbe?.(200, page) ?? "live-empty") === "live-empty";
    }
    const next: Cursor | null = adapter.nextCursor?.(page, cursor, pageItems) ?? null; // omitted ⇒ one fetch
    // Per-board cap — see RunAdapterOptions.maxItems.
    if (maxItems !== undefined && mapped >= maxItems) {
      capped = next !== null || (hydrate !== undefined && mapped > maxItems);
      if (hydrate) listing.length = maxItems;
      break;
    }
    // A later page whose postings all repeat earlier ones: the server is ignoring the offset, and paging
    // on could never end. A page of only malformed items proves nothing either way.
    if (cursor && mapped > mappedBefore && seenIds.size === seenBefore) {
      partial = true;
      break;
    }
    if (!next) break;
    cursor = next;
  }
  // Ended well short of the reported total (an early empty page, say). The slack keeps a slightly
  // overcounting total from marking the board partial on every visit.
  if (!capped && total !== undefined && total - listed > Math.max(5, total * 0.02)) partial = true;

  // Optional hydrate (N+1 second fetch) through a bounded-concurrency pool, a sink page at a time. A
  // per-item failure — ANY failed or empty detail fetch (retries exhausted, a timeout, a 404/410, a body
  // with no content; the adapter throws) — keeps the listed job, because it WAS listed and so is live:
  // ingestion must still count it present. But its description is mapItem's placeholder "", not the
  // posting's text, so it is flagged `contentMissing` and upsertJobs never writes its content — persisted,
  // it would overwrite the stored description, NULL the embedding (a paid re-embed) and flip
  // content_signature, then flip it all back on the next good hydrate.
  let unhydrated = 0;
  let rateLimited: RateLimitedError | undefined;
  if (hydrate) {
    for (let start = 0; start < listing.length; start += SINK_PAGE_SIZE) {
      // After the first rate-limited detail fetch the rest skip theirs (contentMissing, no request) rather
      // than each hitting a host that is throttling us.
      const hydrated = await mapWithConcurrency(
        listing.slice(start, start + SINK_PAGE_SIZE),
        hydrateConcurrency,
        async (job) => {
          if (!rateLimited) {
            try {
              return { ...job, ...(await hydrate(job, ctx, fetchJson)) };
            } catch (err) {
              if (err instanceof RateLimitedError) rateLimited ??= err;
            }
          }
          unhydrated++;
          return { ...job, contentMissing: true as const };
        },
      );
      await handOver(hydrated);
    }
  } else {
    await flush(true);
  }

  if (skipped > 0 || unhydrated > 0) {
    console.warn(
      `${policy.tag}: ${listedIds.size} job(s)` +
        (skipped > 0 ? `, skipped ${skipped} malformed` : "") +
        (unhydrated > 0 ? `, ${unhydrated} un-hydrated (content missing, not written)` : ""),
    );
  }
  return {
    listedIds: [...listedIds],
    contentMissing: missing.size,
    rateLimited,
    capped,
    partial,
    mapSkipped: skipped,
    empty,
  };
}

/** How one board's requests retry and time out (see RunAdapterOptions). */
interface RequestPolicy {
  /** `<source> "<slug>"`: every error's prefix. */
  tag: string;
  maxRetries: number;
  timeoutMs: number;
  maxRetryWaitMs?: number;
  /** The board's time limit as an epoch ms, if it has one. */
  deadline?: number;
}

/**
 * Times out a request whose server goes quiet: armed while it waits for the response head and for each
 * body chunk, never while the body's consumer works (a sink write), so only silence is cut off. Between
 * chunks it also enforces the board's time limit.
 */
class Watchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly controller: AbortController,
    private readonly ms: number,
    private readonly deadline: number | undefined,
  ) {}

  arm(): void {
    this.disarm();
    this.timer = setTimeout(
      () =>
        this.controller.abort(
          new DOMException("The operation was aborted due to timeout", "TimeoutError"),
        ),
      this.ms,
    );
  }

  disarm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Read one body chunk under the timeout (a ChunkReader). */
  readonly read = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (this.deadline !== undefined && Date.now() >= this.deadline) {
      throw new Error("board time limit reached");
    }
    this.arm();
    try {
      return await reader.read();
    } finally {
      this.disarm();
    }
  };
}

/** A detail body over MAX_BODY_BYTES: failed at once, never retried. */
class OversizedBodyError extends Error {}

/**
 * Send one request and hand its 2xx response to `consume`, retrying transient failures with exponential
 * backoff + jitter (honoring `Retry-After`). The single resilient fetch path in the package:
 * - `!res.ok` → drain the body, then retry on 429/5xx or throw a tagged error.
 * - fail-fast mode (`maxRetryWaitMs` set): see {@link RunAdapterOptions.maxRetryWaitMs}.
 * - a body that breaks off or isn't JSON (Workable's HTML 429 page, a proxy cutting a large response) is
 *   retried like a 5xx while `mayRetryBody()` allows: a streamed listing stops allowing it once part of
 *   its body has reached the sink.
 * - a page without its postings array is a tagged error at once; whatever else `consume` throws (the
 *   sink's own failure) passes through untouched and is never retried.
 */
async function requestResilient<T>(
  req: JobsRequest,
  policy: RequestPolicy,
  consume: (res: Response, watchdog: Watchdog) => Promise<T>,
  mayRetryBody: () => boolean = () => true,
): Promise<T> {
  const { tag, maxRetries, timeoutMs, maxRetryWaitMs, deadline } = policy;
  let attempt = 0;
  // Fail-fast mode only: the Retry-After of this request's 429. Once set, the request's next failure ends it.
  let limitedRetryAfterMs: number | undefined;
  // Back off and retry — unless out of attempts, past the board's time limit, or (fail-fast) the wait would
  // exceed maxRetryWaitMs.
  const retry = async (retryAfter?: string | null): Promise<boolean> => {
    if (attempt >= maxRetries) return false;
    if (deadline !== undefined && Date.now() >= deadline) return false;
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
    if (deadline !== undefined && Date.now() >= deadline) {
      throw fail(new Error(`${tag} board time limit reached`));
    }
    // A fresh controller per attempt; merged — never clobbering — with an adapter's own signal on the off
    // chance a future adapter sets one. The abort rejects the fetch, or the body read, like a network fault.
    const controller = new AbortController();
    const watchdog = new Watchdog(controller, timeoutMs, deadline);
    const signal = req.init?.signal
      ? AbortSignal.any([req.init.signal, controller.signal])
      : controller.signal;
    let res: Response;
    watchdog.arm();
    try {
      res = await fetch(req.url, { ...req.init, signal });
    } catch (err) {
      if (limitedRetryAfterMs === undefined && (await retry())) continue;
      throw fail(
        new Error(`${tag} fetch error: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        }),
      );
    } finally {
      watchdog.disarm();
    }

    if (res.ok) {
      try {
        return await consume(res, watchdog);
      } catch (err) {
        if (err instanceof ListingShapeError) {
          throw fail(
            new Error(`${tag} returned an unexpected response shape: ${err.message}`, {
              cause: err,
            }),
          );
        }
        if (err instanceof OversizedBodyError) {
          throw fail(new Error(`${tag} body over ${MAX_BODY_BYTES} bytes`));
        }
        if (!(err instanceof BodyReadError) && !(err instanceof MalformedBodyError)) throw err;
        // The body broke off (a reset, the timeout) or isn't JSON (a truncated or empty 2xx, usually
        // transient): retry like a 5xx rather than hard-failing the board on the first bad read.
        if (mayRetryBody() && limitedRetryAfterMs === undefined && (await retry())) continue;
        throw fail(
          err instanceof BodyReadError
            ? new Error(`${tag} body read error: ${err.message}`, { cause: err })
            : new Error(`${tag} returned a non-JSON body (status ${res.status})`, { cause: err }),
        );
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

/** A detail fetch's 2xx body, read whole (bounded by MAX_BODY_BYTES) and parsed: hydrate's `fetchJson`. */
async function readJson(res: Response, watchdog: Watchdog): Promise<unknown> {
  const text = await readBody(res, watchdog);
  if (text === null) throw new OversizedBodyError();
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new MalformedBodyError({ cause: err });
  }
}

/**
 * A 2xx body as text, decoded like `res.text()` (UTF-8, a leading BOM dropped), or null once it passes
 * {@link MAX_BODY_BYTES} — the stream is cancelled there, so an oversized body is never held whole.
 */
async function readBody(res: Response, watchdog: Watchdog): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await watchdog.read(reader);
    } catch (err) {
      throw new BodyReadError(err);
    }
    if (chunk.done) return text + decoder.decode();
    bytes += chunk.value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      void reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(chunk.value, { stream: true });
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
