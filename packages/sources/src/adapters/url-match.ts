/**
 * Pure URL → raw-slug parsing primitives shared by the adapters' Phase-7 `matchUrl`. Each
 * adapter still owns its host set and its rule; these only factor out the mechanical path/host
 * parsing so nine `matchUrl`s don't each re-implement "first path segment" / "subdomain label".
 * WHATWG `URL` only — Worker-safe — and none throw (a non-matching shape returns `null`/`[]`).
 */

/** Non-empty path segments: `/v1/boards/acme/jobs` → `["v1","boards","acme","jobs"]`; `/` → `[]`. */
export function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

/** The first non-empty path segment, or `null` (e.g. the bare host root). */
export function firstPathSegment(url: URL): string | null {
  return pathSegments(url)[0] ?? null;
}

/**
 * The path segment immediately after the last occurrence of `marker`, or `null` when `marker`
 * is absent or is itself the final segment. Used for `.../{marker}/{slug}/...` API URLs.
 */
export function segmentAfter(url: URL, marker: string): string | null {
  const segs = pathSegments(url);
  const i = segs.lastIndexOf(marker);
  return i >= 0 ? (segs[i + 1] ?? null) : null;
}

/**
 * Non-tenant subdomain labels common to ATS vendors' own infrastructure. A seed `ats_links` entry
 * pointing at one of these (e.g. a marketing page `www.recruitee.com/...`) would otherwise resolve
 * to a phantom tenant (`www`) that passes the universal slug floor and gets probed/upserted.
 */
const RESERVED_SUBDOMAINS = new Set([
  "www",
  "api",
  "app",
  "apps",
  "cdn",
  "static",
  "assets",
  "support",
  "help",
  "docs",
  "blog",
  "mail",
  "admin",
  "status",
  "dashboard",
  "go",
  "info",
]);

/**
 * The tenant label of a per-subdomain host: `acme.recruitee.com` with base `recruitee.com` →
 * `"acme"`; the base host itself (no sub-domain) → `null`. Returns the label ADJACENT to the
 * base domain, or `null` for a reserved non-tenant label (`www`, `api`, …). Hostnames are already
 * lower-cased by the URL parser, so this is case-stable.
 */
export function subdomainLabel(url: URL, baseDomain: string): string | null {
  const host = url.hostname;
  if (host === baseDomain || !host.endsWith("." + baseDomain)) return null;
  const prefix = host.slice(0, host.length - baseDomain.length - 1);
  const label = prefix.split(".").pop() ?? null;
  return label !== null && RESERVED_SUBDOMAINS.has(label) ? null : label;
}
