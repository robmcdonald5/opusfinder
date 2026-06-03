import type { CompanySlug, SourceName } from "@opusfinder/shared";
import { adapters, SOURCE_NAMES } from "@opusfinder/sources";

import type { CompanyRecord } from "./seed";
import type { Candidate } from "./types";

/**
 * Resolve a board URL to its (source, rawSlug) by the FIRST adapter whose `matchUrl` claims it. The
 * 9 adapters' hosts are disjoint (asserted by the sources test suite), so first-match is unambiguous.
 * Returns null when no adapter owns the URL — an unsupported ATS (BambooHR/Workday/…) or a vanity
 * careers page. `rawSlug` is pre-normalize; the caller brands it with the source's `normalizeSlug`.
 */
export function resolveUrl(url: URL): { source: SourceName; rawSlug: string } | null {
  for (const source of SOURCE_NAMES) {
    const rawSlug = adapters[source].matchUrl(url);
    if (rawSlug !== null) return { source, rawSlug };
  }
  return null;
}

/** Brand a raw slug through the source's `normalizeSlug`, or null if it fails the universal floor. */
function tryNormalize(source: SourceName, rawSlug: string): CompanySlug | null {
  try {
    return adapters[source].normalizeSlug(rawSlug);
  } catch {
    return null;
  }
}

export interface ResolveCounts {
  /** Total seed records scanned. */
  seedRecords: number;
  /** Total `ats_links` strings examined. */
  atsLinks: number;
  /** Links that failed to parse as a URL. */
  badUrl: number;
  /** Links that parsed but matched no adapter (unsupported ATS or a vanity careers page). */
  deferredNoAdapter: number;
  /** Links whose slug failed the universal floor (e.g. an Ashby `%20`-spaced slug). */
  invalidSlug: number;
  /** Distinct (source, slug) candidates emitted. */
  candidates: number;
}

/**
 * Turn seed records into a deduped Candidate[] (canonical (source, slug) pairs), tallying what was
 * dropped and why. Each `ats_links` URL is parsed (malformed → `badUrl`, skipped), resolved to an
 * adapter (none → `deferredNoAdapter`), branded via `normalizeSlug` (floor violation → `invalidSlug`),
 * and deduped by canonical (source, slug). `opts.source` scopes to one source (other-source links are
 * skipped, NOT counted as deferred). Nothing throws on bad data — the run continues and reports the
 * tally. Dedup uses `JSON.stringify([source, slug])` (the same collision-proof key idiom as
 * upsertJobs), so two casings of a case-insensitive slug collapse to one candidate.
 */
export function resolveSeed(
  records: CompanyRecord[],
  opts: { source?: SourceName } = {},
): { candidates: Candidate[]; counts: ResolveCounts } {
  const counts: ResolveCounts = {
    seedRecords: records.length,
    atsLinks: 0,
    badUrl: 0,
    deferredNoAdapter: 0,
    invalidSlug: 0,
    candidates: 0,
  };
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const record of records) {
    const links = Array.isArray(record.ats_links) ? record.ats_links : [];
    for (const link of links) {
      if (typeof link !== "string" || link.trim() === "") continue;
      counts.atsLinks += 1;

      let url: URL;
      try {
        url = new URL(link);
      } catch {
        counts.badUrl += 1;
        continue;
      }

      const hit = resolveUrl(url);
      if (!hit) {
        counts.deferredNoAdapter += 1;
        continue;
      }
      if (opts.source && hit.source !== opts.source) continue;

      const slug = tryNormalize(hit.source, hit.rawSlug);
      if (slug === null) {
        counts.invalidSlug += 1;
        continue;
      }

      const key = JSON.stringify([hit.source, slug]);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ source: hit.source, slug, rawSlug: hit.rawSlug, sourceUrl: link });
    }
  }

  counts.candidates = candidates.length;
  return { candidates, counts };
}
