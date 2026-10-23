import { backoff, backoffDelayMs, sleep } from "@opusfinder/shared/async";
import {
  adapters,
  BodyReadError,
  readListingPage,
  type JobsRequest,
  type ProbeOutcome,
  type SourceAdapter,
  type SourceContext,
} from "@opusfinder/sources";

import type { Candidate, ProbeResult } from "./types";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_GLOBAL_CONCURRENCY = 12;
const DEFAULT_HOST_CONCURRENCY = 3;
const DEFAULT_HOST_MIN_INTERVAL_MS = 400;
const THROTTLE_POLL_MS = 25;
// Per-attempt fetch timeout: global `fetch` has none, so a host that accepts the connection and never
// answers would hold its probe — and the run — until the Worker is killed.
const PROBE_FETCH_TIMEOUT_MS = 10_000;

export interface ProbeFetchResult {
  /** HTTP status of the final attempt, or 0 when the network attempt was exhausted (retries spent). */
  status: number;
  /**
   * A 2xx listing page, or `undefined` for a non-2xx, a non-JSON body, or a page without its postings
   * array. NEVER throws.
   */
  page: ProbePage | undefined;
}

/** What a probe read of one 2xx listing page. */
export interface ProbePage {
  /** It lists at least one posting the adapter keeps. */
  listsPosting: boolean;
  /** The page's JSON with its postings array emptied, or `undefined` when the read stopped at the first
   *  posting (`firstPostingOnly`). */
  envelope: unknown;
}

/** How to read a probe's listing page: the adapter's postings array, and whether one posting settles it. */
export interface ProbeListing extends Pick<SourceAdapter, "itemsKey" | "keepItem"> {
  /** Stop at the first kept posting: the default classifier needs nothing more, and a probe never holds a
   *  board's whole listing. False when the adapter's `classifyProbe` reads the page's totals. */
  firstPostingOnly: boolean;
}

/**
 * Fetch one probe request, NON-throwing — the inverse of run-adapter's resilient fetch (which throws on
 * `!ok`). For discovery a 404 / 400 / 200-empty IS the signal, so every response resolves to
 * `{ status, page }`. Retries only the genuinely-transient 429 / 5xx / network error (shared `backoff` +
 * `Retry-After`) — never one that would wait longer than `maxRetryWaitMs`; a definitive 4xx returns
 * immediately, and a 2xx that isn't a listing page returns `{ status, page: undefined }` (indeterminate to
 * every classifier). The 2xx body is streamed like ingestion's, so a probe of a big board holds one chunk,
 * not the board. Worker-forward: global `fetch` + `setTimeout` only.
 */
export async function probeFetch(
  req: JobsRequest,
  listing: ProbeListing,
  maxRetries = DEFAULT_MAX_RETRIES,
  maxRetryWaitMs = Infinity,
): Promise<ProbeFetchResult> {
  const canRetry = (attempt: number, retryAfter?: string | null): boolean =>
    attempt < maxRetries && backoffDelayMs(attempt, retryAfter) <= maxRetryWaitMs;
  for (let attempt = 0; ; ) {
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(PROBE_FETCH_TIMEOUT_MS);
      const signal = req.init?.signal ? AbortSignal.any([req.init.signal, timeout]) : timeout;
      res = await fetch(req.url, { ...req.init, signal });
    } catch {
      if (canRetry(attempt)) {
        await backoff(attempt++);
        continue;
      }
      return { status: 0, page: undefined };
    }

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = res.headers.get("retry-after");
      if (canRetry(attempt, retryAfter)) {
        await res.body?.cancel().catch(() => {});
        await backoff(attempt++, retryAfter);
        continue;
      }
    }

    // Only a 2xx body is meaningful to the classifiers; a final non-2xx is classified from the STATUS
    // alone, so cancel its (possibly large HTML) body rather than buffering it — saves the full-page
    // download on every absent (404/400) probe at scale.
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, page: undefined };
    }
    // The timeout covers the body too: a stalled or reset stream fails like a network throw.
    let listsPosting = false;
    try {
      const envelope = await readListingPage(res.body, listing, () => {
        listsPosting = true;
        return !listing.firstPostingOnly;
      });
      return { status: res.status, page: { listsPosting, envelope } };
    } catch (err) {
      if (!(err instanceof BodyReadError)) return { status: res.status, page: undefined };
      if (canRetry(attempt)) {
        await backoff(attempt++);
        continue;
      }
      return { status: 0, page: undefined };
    }
  }
}

/**
 * Status-first default probe classifier, used when an adapter omits `classifyProbe` (7 of 9). A 404
 * is `absent`; a 2xx listing page that lists a posting is `live`, one listing none `live-empty`, and a 2xx
 * that isn't a listing page `indeterminate`; anything else (status 0, 3xx, other 4xx) is
 * `indeterminate`, so it can never drive a deactivation.
 */
export function defaultClassify(status: number, page: ProbePage | undefined): ProbeOutcome {
  if (status === 404) return "absent";
  if (status >= 200 && status < 300) {
    if (page === undefined) return "indeterminate"; // not a listing page — can't assert live
    return page.listsPosting ? "live" : "live-empty";
  }
  return "indeterminate";
}

function contextOf(c: Candidate): SourceContext {
  return { slug: c.slug, rawSlug: c.rawSlug };
}

/** The probe request for a candidate — the adapter's `probeRequest`, else `jobsRequest` (first page). */
function requestOf(c: Candidate): JobsRequest {
  const adapter = adapters[c.source];
  const ctx = contextOf(c);
  return adapter.probeRequest?.(ctx) ?? adapter.jobsRequest(ctx, null);
}

/** The host a probe will hit (its request URL host); falls back to the raw URL if unparseable. */
function hostOf(req: JobsRequest): string {
  try {
    return new URL(req.url).hostname;
  } catch {
    return req.url;
  }
}

async function probeWith(
  c: Candidate,
  req: JobsRequest,
  maxRetries: number,
  maxRetryWaitMs?: number,
): Promise<ProbeResult> {
  const adapter = adapters[c.source];
  const listing = { ...adapter, firstPostingOnly: adapter.classifyProbe === undefined };
  const { status, page } = await probeFetch(req, listing, maxRetries, maxRetryWaitMs);
  const outcome = adapter.classifyProbe?.(status, page?.envelope) ?? defaultClassify(status, page);
  return { candidate: c, status, outcome };
}

/**
 * A per-host politeness gate: at most `concurrency` probes in flight per host AND at least
 * `minIntervalMs` between two STARTS to the same host. Poll-based — a probe run is bursty and
 * short-lived, so a 25 ms poll is cheaper than a wakeup queue. The check-and-increment in `acquire`
 * is synchronous (no `await` between read and write), so two workers can't both claim the last slot.
 *
 * Exported (not re-exported from the package barrel) so `host-throttle.test.ts` can drive the interval
 * gate directly under fake timers — the concurrency cap / min-interval / release semantics are worth
 * asserting in isolation rather than only through `probeCandidates`.
 */
export class HostThrottle {
  private readonly state = new Map<string, { inFlight: number; lastStart: number }>();

  constructor(
    private readonly concurrency: number,
    private readonly minIntervalMs: number,
  ) {}

  async acquire(host: string): Promise<void> {
    for (;;) {
      const s = this.state.get(host) ?? { inFlight: 0, lastStart: 0 };
      const now = Date.now();
      const sinceStart = now - s.lastStart;
      if (s.inFlight < this.concurrency && sinceStart >= this.minIntervalMs) {
        s.inFlight += 1;
        s.lastStart = now;
        this.state.set(host, s);
        return;
      }
      const wait =
        s.inFlight >= this.concurrency ? THROTTLE_POLL_MS : this.minIntervalMs - sinceStart;
      await sleep(Math.max(wait, THROTTLE_POLL_MS));
    }
  }

  release(host: string): void {
    const s = this.state.get(host);
    if (s) s.inFlight = Math.max(0, s.inFlight - 1);
  }
}

export interface ProbeOptions {
  maxRetries?: number;
  /**
   * Fail fast (Worker): a retry that would wait longer than this — a 429's Retry-After or the backoff — is
   * not made, and the probe ends with its last status (never a live/absent verdict). Omit ⇒ wait it out
   * (≤ 30 s a retry): the CLI.
   */
  maxRetryWaitMs?: number;
  /** Epoch ms past which no new probe starts; a candidate not started by then gets no result. */
  deadline?: number;
  /** Total concurrent probes across all hosts. */
  globalConcurrency?: number;
  /** Max concurrent probes to ONE host (path-based sources share a host; subdomain sources don't). */
  hostConcurrency?: number;
  /** Minimum spacing between two probe STARTS to the same host. */
  hostMinIntervalMs?: number;
}

/**
 * Probe many candidates through a bounded, polite pool: a global concurrency cap PLUS a per-host gate
 * (≤ `hostConcurrency` in flight AND ≥ `hostMinIntervalMs` between starts), so a shared API host (all
 * greenhouse boards hit boards-api.greenhouse.io) isn't hammered while unique subdomain hosts still
 * run in parallel. Results preserve input order, and the batch never rejects: a candidate whose probe
 * throws resolves as status 0 / `indeterminate`. Past `opts.deadline` the unstarted candidates are left
 * as holes (`results[i]` undefined).
 */
export async function probeCandidates(
  candidates: Candidate[],
  opts: ProbeOptions = {},
): Promise<ProbeResult[]> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const globalConcurrency = opts.globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY;
  const throttle = new HostThrottle(
    opts.hostConcurrency ?? DEFAULT_HOST_CONCURRENCY,
    opts.hostMinIntervalMs ?? DEFAULT_HOST_MIN_INTERVAL_MS,
  );

  const results = new Array<ProbeResult>(candidates.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= candidates.length) return;
      const c = candidates[i];
      if (!c) continue;
      try {
        const req = requestOf(c);
        const host = hostOf(req);
        await throttle.acquire(host);
        try {
          // Checked after the host slot, which can take a while: this worker stops, leaving `i` a hole.
          if (opts.deadline !== undefined && Date.now() >= opts.deadline) return;
          results[i] = await probeWith(c, req, maxRetries, opts.maxRetryWaitMs);
        } finally {
          throttle.release(host);
        }
      } catch (err) {
        // E.g. a stored source no adapter knows. Status 0 is inconclusive: never a live/absent verdict, and
        // the reprobe pass still advances the row so it can't pin the head of the queue.
        console.error(
          `[discovery] probe of a "${c.source}" candidate threw: ` +
            (err instanceof Error ? err.message : String(err)).slice(0, 200),
        );
        results[i] = { candidate: c, status: 0, outcome: "indeterminate" };
      }
    }
  };

  const workers = Math.min(Math.max(globalConcurrency, 1), Math.max(candidates.length, 1));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
