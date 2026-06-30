import { companySlug, isRecord, safeJobId } from "@opusfinder/shared";
import type { NormalizedJob } from "@opusfinder/shared";

import { inferRemoteFromText, joinParts } from "./fields";
import { htmlToText } from "./text";
import type { SourceAdapter, SourceContext } from "./types";
import { firstPathSegment, segmentAfter } from "./url-match";

const WIDGET_API = "https://apply.workable.com/api/v1/widget/accounts";
const WIDGET_API_URL = new URL(WIDGET_API);
const WIDGET_API_HOST = WIDGET_API_URL.hostname;
const WIDGET_API_PATH = WIDGET_API_URL.pathname;
// First-path-segment tokens on apply.workable.com that are NOT a board slug (API version paths,
// the /j/ short-link, the /jobs alias). A bare /{slug} outside these IS a board slug. v1/v2/v3
// cover the widget-API version prefixes so a version token is never mistaken for a tenant.
const RESERVED_FIRST_SEGMENTS = new Set(["api", "v1", "v2", "v3", "accounts", "j", "jobs"]);

/**
 * Workable account-widget adapter. Returns the full board in one (potentially large)
 * `{ name, description, jobs }` response — no pagination (`nextCursor` omitted).
 *
 * Hydration is INLINE, not an N+1: the descriptions arrive on every posting when the list
 * request carries `?details=true` (the per-job widget path 404s on the public host), so
 * that is a `jobsRequest` query param, not a `hydrate` second fetch. Slugs are case-
 * sensitive lowercase, so `normalizeSlug` lowercases. The host RATE-LIMITS rapid calls
 * (429 with an HTML body) — handled centrally by runAdapter's backoff + non-JSON guard.
 */
export const workableAdapter: SourceAdapter = {
  source: "workable",

  // Lowercase: canonical board slugs are lowercase and the host 404s other casings.
  normalizeSlug: (rawSlug) => companySlug(rawSlug.toLowerCase()),

  // apply.workable.com only. The widget-API path → segment after "accounts"; otherwise a bare
  // /{slug} board path, unless the first segment is a reserved (non-slug) token.
  matchUrl: (url) => {
    if (url.hostname !== WIDGET_API_HOST) return null;
    if (url.pathname.startsWith(WIDGET_API_PATH + "/")) return segmentAfter(url, "accounts");
    const firstSegment = firstPathSegment(url);
    return firstSegment && !RESERVED_FIRST_SEGMENTS.has(firstSegment) ? firstSegment : null;
  },

  jobsRequest: (ctx) => ({ url: `${WIDGET_API}/${ctx.slug}?details=true` }),

  locate: (body, ctx) => {
    // body.name / body.description are the COMPANY blurb, not job data — only body.jobs[].
    if (!isRecord(body) || !Array.isArray(body.jobs)) {
      throw new Error(`Workable returned an unexpected response shape for "${ctx.slug}"`);
    }
    return body.jobs;
  },

  mapItem: (raw, ctx) => toNormalizedJob(raw, ctx),
};

function toNormalizedJob(raw: unknown, ctx: SourceContext): NormalizedJob | null {
  if (!isRecord(raw)) return null;
  // The posting id is `shortcode` (an alphanumeric code), already a string.
  const externalId = safeJobId(raw.shortcode);
  if (externalId === null) return null;
  if (typeof raw.title !== "string") return null;

  const applyUrl =
    (typeof raw.url === "string" && raw.url) ||
    (typeof raw.shortlink === "string" && raw.shortlink) ||
    "";
  if (!applyUrl) return null;

  const locations = extractLocations(raw);

  // Structured `telecommuting` flag, OR infer from the location text (a posting can be
  // text-only remote with telecommuting=false). "Hybrid" stays false unless text says remote.
  const remote = raw.telecommuting === true || inferRemoteFromText(locations);

  // `published_on` / `created_at` are date-only "YYYY-MM-DD" (parsed as UTC midnight). `||`
  // (not `??`) so an empty string falls through to created_at.
  const dateText =
    (typeof raw.published_on === "string" ? raw.published_on : "") ||
    (typeof raw.created_at === "string" ? raw.created_at : "");
  const parsed = dateText ? new Date(dateText) : null;
  const postedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;

  return {
    source: "workable",
    externalId,
    title: raw.title,
    companySlug: ctx.slug,
    locations,
    remote,
    // `description` is single-encoded HTML, present only with ?details=true (the htmlToText recipe).
    descriptionText: htmlToText(raw.description),
    applyUrl,
    postedAt,
    raw,
  };
}

/**
 * Compose a display string per `locations[]` entry from city/region/country (skipping
 * hidden ones); fall back to the flat top-level city/state/country. `[]` if none.
 */
function extractLocations(raw: Record<string, unknown>): string[] {
  const locations: string[] = [];
  if (Array.isArray(raw.locations)) {
    for (const loc of raw.locations) {
      if (!isRecord(loc) || loc.hidden === true) continue;
      const composed = joinParts([loc.city, loc.region, loc.country]);
      if (composed) locations.push(composed);
    }
  }
  if (locations.length === 0) {
    const flatLocation = joinParts([raw.city, raw.state, raw.country]);
    if (flatLocation) locations.push(flatLocation);
  }
  return locations;
}
