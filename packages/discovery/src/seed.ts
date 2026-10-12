import { backoff } from "@opusfinder/shared/async";

import { fetchHnAlgoliaLane } from "./lanes/hn";

/**
 * The discovery seed: outscal/OpenJobs `data/companies_v2.json` — ~12k gaming/tech companies, each with
 * an `ats_links[]` of public job-board URLs. Pinned to a commit SHA so a bootstrap run is deterministic
 * and immune to an upstream schema/file move; bump SEED_SHA to refresh. CC-BY-NC dataset — we read only
 * the public board URLs to validate slugs; many `ats_links` are vanity careers pages, so most records
 * resolve to no adapter (expected).
 */
const SEED_SHA = "cdcc533521afb61f4e60657b3dbe06e484ccddcf"; // outscal/OpenJobs main @ 2026-04-22
export const SEED_URL = `https://raw.githubusercontent.com/outscal/OpenJobs/${SEED_SHA}/data/companies_v2.json`;

/**
 * One seed record — only the fields discovery reads (`name` for logging, `ats_links` for resolution);
 * the rest (game_genre, tech_stack, countries, list_urls, …) are ignored. Typed LOOSELY because the
 * JSON is untrusted: the resolver guards every field at the use site (Array.isArray, typeof string).
 */
export interface CompanyRecord {
  name?: string;
  ats_links?: string[];
}

// Per attempt, body included: the weekly Worker run must not hang on the seed GET.
const SEED_FETCH_TIMEOUT_MS = 30_000;
const SEED_MAX_RETRIES = 2;

/**
 * Fetch + parse the pinned seed into records. Validates only the top-level array shape; per-record
 * fields are validated downstream by the resolver. A transient failure (network error or cut body, 429,
 * 5xx) is retried with the shared `backoff`; past that, a non-2xx or non-array body THROWS — a broken
 * seed should fail the run loudly, not silently yield zero candidates.
 */
export async function loadSeed(url: string = SEED_URL): Promise<CompanyRecord[]> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(SEED_FETCH_TIMEOUT_MS) });
    } catch (err) {
      if (attempt < SEED_MAX_RETRIES) {
        await backoff(attempt);
        continue;
      }
      throw err;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if ((res.status === 429 || res.status >= 500) && attempt < SEED_MAX_RETRIES) {
        await backoff(attempt, res.headers.get("retry-after"));
        continue;
      }
      throw new Error(`Seed fetch failed: ${res.status} ${res.statusText}`);
    }
    // A body cut mid-stream (or timed out) is a network failure, not a broken seed: retry it like one.
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (attempt < SEED_MAX_RETRIES) {
        await backoff(attempt);
        continue;
      }
      throw err;
    }
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) {
      throw new Error("Seed is not a JSON array of company records");
    }
    return data as CompanyRecord[];
  }
}

/**
 * A discovery SEED LANE: a named source of `CompanyRecord[]` that plugs in BEFORE `resolveSeed`. Each lane
 * OWNS mapping its raw fetch output into `{ name?, ats_links? }`; `resolveSeed` owns URL→(source, slug). The
 * `name` is the `lane_<name>_*` counter prefix + log label (lowercase, no spaces); `workerSafe` gates the
 * Worker loop — a fetch-only, bundle-safe lane is `true`, a Node-only lane (passive DNS / Common Crawl) is
 * `false` and runs CLI-only.
 */
export interface SeedLane {
  name: string;
  workerSafe: boolean;
  /**
   * true = a fetch failure is RUN-FATAL (re-thrown) — the core seed's fail-loud floor: a broken outscal
   * seed should fail the run loudly, not silently yield zero. Omit/false = ISOLATED (the
   * failure is tallied as `lane_<name>_error` and the loop continues), so one flaky external lane can't
   * zero a run a reliable lane would have fed. New external lanes (HN, …) default to isolated.
   */
  failLoud?: boolean;
  fetch: () => Promise<CompanyRecord[]>;
}

/**
 * The lane registry — discovery supply's single extension point. Node runs every lane; the Worker filters
 * to `workerSafe` ones via `runDiscovery`'s `opts.workerOnly`. Grow supply by adding a lane HERE, not by
 * touching the pipeline. ORDER MATTERS: the worklist follows it and a capped run (`opts.limit`) keeps only
 * its head, so fresh-supply lanes go first. The frozen outscal seed's never-live slugs are re-probed every
 * run and would otherwise fill the cap ahead of them.
 */
export const SEED_LANES: SeedLane[] = [
  { name: "hn", workerSafe: true, fetch: fetchHnAlgoliaLane }, // isolated (no failLoud): an Algolia hiccup tallies lane_hn_error, never zeroes a run
  { name: "outscal", workerSafe: true, failLoud: true, fetch: () => loadSeed() },
];
