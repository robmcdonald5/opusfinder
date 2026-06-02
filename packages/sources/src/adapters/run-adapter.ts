import type { NormalizedJob } from "@opusfinder/shared";

import type { Cursor, FetchJson, JobsRequest, SourceAdapter, SourceContext } from "./types";

/**
 * The invariant ATS-ingestion plumbing, EXTRACTED (Phase 6) from the concrete Greenhouse,
 * Lever, and SmartRecruiters adapters. Everything that is the SAME across sources lives
 * here; everything that DIFFERS lives on the per-source `SourceAdapter` descriptor.
 *
 * runAdapter owns: slug normalization → the pagination loop (jobsRequest → fetch → locate →
 * map) → the single resilient fetch (retry/backoff/Retry-After + non-JSON guard) → two-tier
 * resilience (locate fails LOUD on a bad envelope; mapItem fails SOFT, skipping one bad
 * posting) → the optional bounded-concurrency hydrate pool → per-board accounting. It returns
 * `NormalizedJob[]`, the same contract the per-source `fetchJobs(slug)` used to expose.
 *
 * Worker-forward (Phase 8): global `fetch`/`RequestInit` only, `setTimeout`-based backoff,
 * `Math.random` jitter, no Node-only APIs and no `process.env` reads.
 */
export interface RunAdapterOptions {
  /** Max concurrent `hydrate` calls (Worker subrequest budgets may want this lower). */
  hydrateConcurrency?: number;
  /** Max retry attempts on a transient failure (429 / 5xx / network throw). */
  maxRetries?: number;
}

const DEFAULT_HYDRATE_CONCURRENCY = 5;
const DEFAULT_MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 15_000;
const MAX_RETRY_AFTER_MS = 30_000;

export async function runAdapter(
  adapter: SourceAdapter,
  rawSlug: string,
  opts: RunAdapterOptions = {},
): Promise<NormalizedJob[]> {
  const hydrateConcurrency = opts.hydrateConcurrency ?? DEFAULT_HYDRATE_CONCURRENCY;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  const ctx: SourceContext = { slug: adapter.normalizeSlug(rawSlug), rawSlug };
  const tag = `${adapter.source} "${ctx.slug}"`;
  const fetchJson: FetchJson = (req) => fetchJsonResilient(req, tag, maxRetries);

  // Pagination loop. Keep each raw item beside its mapped job so hydrate has both.
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
        mapped.push({ raw, job });
      } else {
        skipped++;
      }
    }
    if (!adapter.nextCursor) break; // omitted ⇒ single unpaginated fetch
    const next = adapter.nextCursor(body, cursor, items.length);
    if (!next) break;
    cursor = next;
  }

  // Optional hydrate (N+1 second fetch) through a bounded-concurrency pool. A per-item
  // failure keeps the already-valid mapped job (mapItem's contract guarantees it is usable).
  let jobs: NormalizedJob[];
  let unhydrated = 0;
  const hydrate = adapter.hydrate;
  if (hydrate) {
    jobs = await mapWithConcurrency(mapped, hydrateConcurrency, async ({ raw, job }) => {
      try {
        return { ...job, ...(await hydrate(job, raw, ctx, fetchJson)) };
      } catch {
        unhydrated++;
        return job;
      }
    });
  } else {
    jobs = mapped.map((m) => m.job);
  }

  if (skipped > 0 || unhydrated > 0) {
    console.warn(
      `${tag}: ${jobs.length} job(s)` +
        (skipped > 0 ? `, skipped ${skipped} malformed` : "") +
        (unhydrated > 0 ? `, ${unhydrated} un-hydrated` : ""),
    );
  }
  return jobs;
}

/**
 * Fetch one request and parse JSON, retrying transient failures with exponential backoff +
 * jitter (honoring `Retry-After`). The single resilient fetch path in the package:
 * - `!res.ok` → drain the body, then retry on 429/5xx or throw a tagged error.
 * - guard non-JSON bodies (e.g. Workable's HTML 429 / text 404) by catching the parse into
 *   the tagged error rather than surfacing a raw SyntaxError.
 */
async function fetchJsonResilient(
  req: JobsRequest,
  tag: string,
  maxRetries: number,
): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(req.url, req.init);
    } catch (err) {
      if (attempt < maxRetries) {
        await backoff(attempt++);
        continue;
      }
      throw new Error(`${tag} fetch error: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }

    if (res.ok) {
      const text = await res.text();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // A truncated/empty body on a 2xx is usually transient (a proxy cutting a large
        // response mid-stream, an edge hiccup) — retry like a 5xx rather than hard-failing
        // the whole board on the first bad read.
        if (attempt < maxRetries) {
          await backoff(attempt++);
          continue;
        }
        throw new Error(`${tag} returned a non-JSON body (status ${res.status})`);
      }
    }

    // Non-OK: release the (possibly HTML/text) body so no socket lingers, then retry or fail.
    const retryAfter = res.headers.get("retry-after");
    await res.body?.cancel().catch(() => {});
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxRetries) {
      await backoff(attempt++, retryAfter);
      continue;
    }
    throw new Error(`${tag} fetch failed: ${res.status} ${res.statusText}`);
  }
}

/** Exponential backoff with jitter; honors a numeric `Retry-After` (seconds) when present. */
function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
  let ms = Math.min(2000 * 2 ** attempt, MAX_BACKOFF_MS);
  if (retryAfter) {
    // Retry-After is either delta-seconds (a number) or an HTTP-date (RFC 7231 allows both).
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
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
