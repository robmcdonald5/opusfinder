import { backoff, sleep } from "@opusfinder/shared/async";
import {
  adapters,
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

export interface ProbeFetchResult {
  /** HTTP status of the final attempt, or 0 when the network attempt was exhausted (retries spent). */
  status: number;
  /** Parsed JSON body, or `undefined` for a non-JSON / unparsed body. NEVER throws. */
  body: unknown;
}

/**
 * Fetch one probe request, NON-throwing — the inverse of run-adapter's `fetchJsonResilient` (which
 * throws on `!ok`). For discovery a 404 / 400 / 200-empty IS the signal, so every response resolves
 * to `{ status, body }`. Retries only the genuinely-transient 429 / 5xx / network error (shared
 * `backoff` + `Retry-After`); a definitive 4xx returns immediately, and a non-JSON 2xx returns
 * `{ status, body: undefined }` (the classifier reads the status; `locate(undefined)` ⇒ indeterminate).
 * Worker-forward: global `fetch` + `setTimeout` only.
 */
export async function probeFetch(
  req: JobsRequest,
  maxRetries = DEFAULT_MAX_RETRIES,
): Promise<ProbeFetchResult> {
  for (let attempt = 0; ; ) {
    let res: Response;
    try {
      res = await fetch(req.url, req.init);
    } catch {
      if (attempt < maxRetries) {
        await backoff(attempt++);
        continue;
      }
      return { status: 0, body: undefined };
    }

    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      await res.body?.cancel().catch(() => {});
      await backoff(attempt++, res.headers.get("retry-after"));
      continue;
    }

    // Only a 2xx body is meaningful to the classifiers (locate / classifyProbe read it); a final
    // non-2xx is classified from the STATUS alone, so cancel its (possibly large HTML) body rather
    // than buffering it — saves the full-page download on every absent (404/400) probe at scale.
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, body: undefined };
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  }
}

/**
 * Status-first default probe classifier, used when an adapter omits `classifyProbe` (7 of 9). A 404
 * is `absent` WITHOUT calling `locate`; a 2xx runs `locate` (non-empty ⇒ live, empty ⇒ live-empty, a
 * throw on a malformed envelope ⇒ indeterminate); anything else (status 0, 3xx, other 4xx) is
 * `indeterminate`, so it can never drive a deactivation.
 */
export function defaultClassify(
  adapter: SourceAdapter,
  status: number,
  body: unknown,
  ctx: SourceContext,
): ProbeOutcome {
  if (status === 404) return "absent";
  if (status >= 200 && status < 300) {
    if (body === undefined) return "indeterminate"; // body-less 2xx (204 / non-JSON) — can't assert live
    try {
      return adapter.locate(body, ctx).length > 0 ? "live" : "live-empty";
    } catch {
      return "indeterminate";
    }
  }
  return "indeterminate";
}

function contextOf(c: Candidate): SourceContext {
  return { slug: c.slug, rawSlug: c.rawSlug };
}

/** The probe request for a candidate — reuses `jobsRequest` (first page, no cursor). */
function requestOf(c: Candidate): JobsRequest {
  return adapters[c.source].jobsRequest(contextOf(c), null);
}

/** The host a probe will hit (its `jobsRequest` URL host); falls back to the raw URL if unparseable. */
function hostOf(req: JobsRequest): string {
  try {
    return new URL(req.url).hostname;
  } catch {
    return req.url;
  }
}

async function probeWith(c: Candidate, req: JobsRequest, maxRetries: number): Promise<ProbeResult> {
  const adapter = adapters[c.source];
  const ctx = contextOf(c);
  const { status, body } = await probeFetch(req, maxRetries);
  const outcome =
    adapter.classifyProbe?.(status, body) ?? defaultClassify(adapter, status, body, ctx);
  return { candidate: c, status, outcome };
}

/** Probe ONE candidate (build its `jobsRequest`, fetch, classify). The single-candidate entry point. */
export function probeCandidate(
  c: Candidate,
  maxRetries = DEFAULT_MAX_RETRIES,
): Promise<ProbeResult> {
  return probeWith(c, requestOf(c), maxRetries);
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
 * run in parallel. Results preserve input order.
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
      const req = requestOf(c);
      const host = hostOf(req);
      await throttle.acquire(host);
      try {
        results[i] = await probeWith(c, req, maxRetries);
      } finally {
        throttle.release(host);
      }
    }
  };

  const workers = Math.min(Math.max(globalConcurrency, 1), Math.max(candidates.length, 1));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
