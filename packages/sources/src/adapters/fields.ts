/**
 * Shared helpers for the ATS adapters — companions to `text.ts` (which derives `descriptionText`).
 * Each captures an INVARIANT several adapters share, so the rule lives once; the per-source
 * VARIATION (which fields feed in, which enum spellings count as remote) stays in each adapter.
 *
 * Pure string/array operations only — no Node APIs — so these run unchanged in a Cloudflare Worker.
 */
import type { Cursor } from "./types";

/**
 * Compose a single location string from ordered parts (e.g. city/region/country): drop
 * non-string and blank parts, trim the rest, join with ", ". Returns "" when no part survives.
 * Callers wrap the result for the `locations` array: `const c = joinParts([...]); return c ? [c] : []`.
 */
export function joinParts(parts: unknown[]): string {
  return parts
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim())
    .join(", ");
}

/** A "remote" that doesn't make a location remote: negated ("Non-Remote", "not remote") or qualified
 *  as hybrid ("Hybrid Remote", "Hybrid, remote 2 days/week", "Remote (Hybrid)"). No comma after
 *  "remote": "Remote, Hybrid or On-site" lists options and stays remote. */
const NOT_REMOTE =
  /\b(?:non|not|no)[- ]?remote\b|\bhybrid[\s,(-]*remote\b|\bremote[\s(-]*hybrid\b/gi;

/**
 * Best-effort remote inference from location strings: true iff any location contains the word
 * "remote" (word-boundary, case-insensitive) outside a NOT_REMOTE phrase, so Hybrid resolves to false
 * per the NormalizedJob contract. Each location is judged alone: "Remote - US" beside "NYC (Hybrid)"
 * stays remote, as does "Remote or Hybrid". The shared FALLBACK used by every adapter that has no
 * authoritative structured remote signal — or as the last resort AFTER one.
 */
export function inferRemoteFromText(locations: string[]): boolean {
  return locations.some((location) => /\bremote\b/i.test(location.replace(NOT_REMOTE, " ")));
}

/**
 * The next page of an offset-paginated listing (SmartRecruiters, Trakstar). Advances by the actual page
 * size (robust to a server-side limit clamp). An empty page always ends it. With the board's reported
 * `total`, stop once the window covers it; without one (API drift), keep going while pages are full and
 * let the short or empty page end it. runAdapter judges whether the listing came back complete.
 */
export function nextOffset(
  total: number | undefined,
  prevCursor: Cursor | null,
  pageItemCount: number,
  pageLimit: number,
): Cursor | null {
  if (pageItemCount === 0) return null;
  const offset = (prevCursor ? prevCursor.offset : 0) + pageItemCount;
  if (total !== undefined) return offset >= total ? null : { kind: "offset", offset };
  return pageItemCount < pageLimit ? null : { kind: "offset", offset };
}
