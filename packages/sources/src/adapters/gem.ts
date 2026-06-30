import { companySlug, isRecord, safeJobId } from "@opusfinder/shared";
import type { NormalizedJob } from "@opusfinder/shared";

import { inferRemoteFromText } from "./fields";
import { cleanHtml, htmlToText } from "./text";
import type { SourceAdapter, SourceContext } from "./types";
import { firstPathSegment, segmentAfter } from "./url-match";

const JOB_BOARD_API = "https://api.gem.com/job_board/v0";
const API_HOST = new URL(JOB_BOARD_API).hostname;
const PUBLIC_HOST = "jobs.gem.com";

/**
 * Gem job-board adapter. Gem white-labels a Greenhouse-style board but serves it as a BARE
 * top-level array (like Lever), so `locate` accepts an array and throws if it isn't one — there
 * is no `{ jobs }` envelope. Returns the whole board in one response (no pagination, `nextCursor`
 * omitted) with descriptions inline (no hydrate). See the inline comments for the per-field quirks
 * (case-sensitive host, required trailing slash, string `id`, `location_type` enum, `content_plain`).
 */
export const gemAdapter: SourceAdapter = {
  source: "gem",

  // Case-sensitive host (an uppercased slug 404s): trim only, never lowercase.
  normalizeSlug: (rawSlug) => companySlug(rawSlug),

  // jobs.gem.com/{slug} OR api.gem.com/job_board/v0/{slug}/... . NOT Greenhouse-shaped apply URLs
  // (Gem white-labels a Greenhouse board, but those hosts belong to the greenhouse adapter).
  matchUrl: (url) =>
    url.hostname === PUBLIC_HOST
      ? firstPathSegment(url)
      : url.hostname === API_HOST
        ? segmentAfter(url, "v0")
        : null,

  // The trailing slash on /job_posts/ is required by the endpoint.
  jobsRequest: (ctx) => ({ url: `${JOB_BOARD_API}/${ctx.slug}/job_posts/` }),

  locate: (body, ctx) => {
    if (!Array.isArray(body)) {
      throw new Error(`Gem returned an unexpected response shape for "${ctx.slug}"`);
    }
    return body;
  },

  mapItem: (raw, ctx) => toNormalizedJob(raw, ctx),
};

function toNormalizedJob(raw: unknown, ctx: SourceContext): NormalizedJob | null {
  if (!isRecord(raw)) return null;
  // `id` is already a string (legacy numeric-strings AND opaque tokens) — no String() needed.
  const externalId = safeJobId(raw.id);
  if (externalId === null) return null;
  if (typeof raw.title !== "string") return null;

  const applyUrl = typeof raw.absolute_url === "string" && raw.absolute_url ? raw.absolute_url : "";
  if (!applyUrl) return null;

  const locations = extractLocations(raw);

  // Structured `location_type` enum: "remote" ⇒ true; "hybrid"/"in_office" ⇒ false. Anything
  // else (absent/unknown) infers from the location text rather than defaulting to false.
  const locationType = typeof raw.location_type === "string" ? raw.location_type : "";
  const remote =
    locationType === "remote"
      ? true
      : locationType === "hybrid" || locationType === "in_office"
        ? false
        : inferRemoteFromText(locations);

  let postedAt: Date | null = null;
  if (typeof raw.first_published_at === "string" && raw.first_published_at) {
    const parsed = new Date(raw.first_published_at);
    postedAt = Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // Prefer the genuine plain-text `content_plain` (collapse only). Fall back to the single-
  // encoded HTML `content` (strip → decode once → collapse) only if content_plain is empty.
  const plain = typeof raw.content_plain === "string" ? raw.content_plain : "";
  const descriptionText = plain.trim() ? cleanHtml(plain, ["collapse"]) : htmlToText(raw.content);

  return {
    source: "gem",
    externalId,
    title: raw.title,
    companySlug: ctx.slug,
    locations,
    remote,
    descriptionText,
    applyUrl,
    postedAt,
    raw,
  };
}

/** Prefer the multi-office `offices[].location.name`; fall back to the single `location.name`. */
function extractLocations(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (Array.isArray(raw.offices)) {
    for (const office of raw.offices) {
      if (
        isRecord(office) &&
        isRecord(office.location) &&
        typeof office.location.name === "string"
      ) {
        const name = office.location.name.trim();
        if (name) out.push(name);
      }
    }
  }
  if (out.length === 0 && isRecord(raw.location) && typeof raw.location.name === "string") {
    const name = raw.location.name.trim();
    if (name) out.push(name);
  }
  return out;
}
