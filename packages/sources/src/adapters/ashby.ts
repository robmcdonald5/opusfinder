import { companySlug, isRecord, jobId } from "@opusfinder/shared";
import type { NormalizedJob } from "@opusfinder/shared";

import { inferRemoteFromText } from "./fields";
import { cleanHtml, htmlToText } from "./text";
import type { SourceAdapter, SourceContext } from "./types";

const JOB_BOARD_API = "https://api.ashbyhq.com/posting-api/job-board";

/**
 * Ashby job-board adapter. Returns every posting in one `{ jobs, apiVersion }` response,
 * so there is no pagination (`nextCursor` omitted) and no hydration — `descriptionPlain`
 * is present inline.
 *
 * Quirks: the server is case-INSENSITIVE but apply URLs echo the input casing and boards
 * are conventionally capitalized, so `normalizeSlug` PRESERVES casing (Phase 6 seeding
 * supplies one canonical casing per board; Phase 7 owns dedupe). `isRemote` is a TRAP — it
 * is `true` on Hybrid postings — so `remote` is derived from `workplaceType`, which can be
 * null (then fall back to inferring from the location text).
 */
export const ashbyAdapter: SourceAdapter = {
  source: "ashby",

  // Case-preserving: keep the caller's casing so apply URLs stay canonical.
  normalizeSlug: (rawSlug) => companySlug(rawSlug),

  jobsRequest: (ctx) => ({
    url: `${JOB_BOARD_API}/${ctx.slug}?includeCompensation=true`,
  }),

  locate: (body, ctx) => {
    if (!isRecord(body) || !Array.isArray(body.jobs)) {
      throw new Error(`Ashby returned an unexpected response shape for "${ctx.slug}"`);
    }
    return body.jobs;
  },

  mapItem: (raw, ctx) => toNormalizedJob(raw, ctx),
};

function toNormalizedJob(raw: unknown, ctx: SourceContext): NormalizedJob | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) return null;
  if (typeof raw.title !== "string") return null;

  const applyUrl =
    (typeof raw.applyUrl === "string" && raw.applyUrl) ||
    (typeof raw.jobUrl === "string" && raw.jobUrl) ||
    "";
  if (!applyUrl) return null;

  const locations = extractLocations(raw);

  // Use STRUCTURED workplaceType, NOT isRemote (true on Hybrid postings). KNOWN values are
  // authoritative: "Remote" ⇒ true, "Hybrid"/"OnSite" ⇒ false. Anything else (null, or an
  // unrecognized value) infers from the location text rather than defaulting to false.
  const workplaceType = typeof raw.workplaceType === "string" ? raw.workplaceType : "";
  const remote =
    workplaceType === "Remote"
      ? true
      : workplaceType === "Hybrid" || workplaceType === "OnSite"
        ? false
        : inferRemoteFromText(locations);

  let postedAt: Date | null = null;
  if (typeof raw.publishedAt === "string" && raw.publishedAt) {
    const parsed = new Date(raw.publishedAt);
    postedAt = Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // descriptionPlain is genuine plain text (collapse only). Fall back to the single-encoded
  // descriptionHtml (strip → decode once → collapse) only if the plain text is empty.
  const plain = typeof raw.descriptionPlain === "string" ? raw.descriptionPlain : "";
  const descriptionText = plain.trim()
    ? cleanHtml(plain, ["collapse"])
    : htmlToText(raw.descriptionHtml);

  return {
    source: "ashby",
    externalId: jobId(raw.id),
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

/** Primary `location` string plus each `secondaryLocations[].location` (multi-office). */
function extractLocations(raw: Record<string, unknown>): string[] {
  const locations: string[] = [];
  if (typeof raw.location === "string" && raw.location.trim()) {
    locations.push(raw.location.trim());
  }
  if (Array.isArray(raw.secondaryLocations)) {
    for (const sl of raw.secondaryLocations) {
      if (isRecord(sl) && typeof sl.location === "string" && sl.location.trim()) {
        locations.push(sl.location.trim());
      }
    }
  }
  return locations;
}
