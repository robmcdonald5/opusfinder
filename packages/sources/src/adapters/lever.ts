import { companySlug, isRecord, jobId } from "@opusfinder/shared";
import type { NormalizedJob } from "@opusfinder/shared";

import { inferRemoteFromText } from "./fields";
import { cleanHtml } from "./text";
import type { SourceAdapter, SourceContext } from "./types";
import { firstPathSegment, segmentAfter } from "./url-match";

// US host only. EU tenants live on api.eu.lever.co (the .co host 404s them).
const POSTINGS_API = "https://api.lever.co/v0/postings";
const API_HOST = new URL(POSTINGS_API).hostname;
const PUBLIC_HOST = "jobs.lever.co";

/**
 * Lever board adapter. The board returns ALL postings in one BARE top-level array (no
 * `{ jobs }` envelope), so there is no pagination (`nextCursor` omitted) and no hydration.
 * Slugs are case-sensitive, so `normalizeSlug` preserves casing.
 *
 * Quirks vs Greenhouse: bare-array response; UUID-string `id`; title on `text` (not
 * `title`); ms-epoch `createdAt`; structured `workplaceType` remote signal. Lever's stored
 * text can carry source-baked mojibake that no decoding repairs — it ships verbatim.
 */
export const leverAdapter: SourceAdapter = {
  source: "lever",

  // Case-sensitive: trim only, never lowercase.
  normalizeSlug: (rawSlug) => companySlug(rawSlug),

  // jobs.lever.co/{slug} OR api.lever.co/v0/postings/{slug}. EU hosts (jobs.eu.lever.co /
  // api.eu.lever.co) deliberately return null — the US-only probe can't validate them.
  matchUrl: (url) =>
    url.hostname === PUBLIC_HOST
      ? firstPathSegment(url)
      : url.hostname === API_HOST
        ? segmentAfter(url, "postings")
        : null,

  jobsRequest: (ctx) => ({ url: `${POSTINGS_API}/${ctx.slug}?mode=json` }),

  locate: (body, ctx) => {
    if (!Array.isArray(body)) {
      throw new Error(`Lever returned an unexpected response shape for "${ctx.slug}"`);
    }
    return body;
  },

  mapItem: (raw, ctx) => toNormalizedJob(raw, ctx),
};

function toNormalizedJob(raw: unknown, ctx: SourceContext): NormalizedJob | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) return null;
  if (typeof raw.text !== "string") return null;

  const applyUrl =
    (typeof raw.applyUrl === "string" && raw.applyUrl) ||
    (typeof raw.hostedUrl === "string" && raw.hostedUrl) ||
    "";
  if (!applyUrl) return null;

  const categories = isRecord(raw.categories) ? raw.categories : undefined;
  const locations = extractLocations(categories);

  // Structured remote signal. KNOWN values are authoritative: "remote" ⇒ true,
  // "onsite"/"hybrid" ⇒ false. Anything else (absent, "unspecified", or an unrecognized
  // value) infers from the location text rather than silently defaulting to false.
  const workplaceType = typeof raw.workplaceType === "string" ? raw.workplaceType : "";
  const remote =
    workplaceType === "remote"
      ? true
      : workplaceType === "onsite" || workplaceType === "hybrid"
        ? false
        : inferRemoteFromText(locations);

  // `createdAt` is milliseconds-since-epoch (an integer), not an ISO string.
  let postedAt: Date | null = null;
  if (typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)) {
    const parsed = new Date(raw.createdAt);
    postedAt = Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return {
    source: "lever",
    externalId: jobId(raw.id),
    title: raw.text,
    companySlug: ctx.slug,
    locations,
    remote,
    // `descriptionPlain` is pre-stripped plain text (opening + body), so only collapse is
    // needed. The richer `lists[]`/`additional` sections + the HTML `description` stay on `raw`.
    descriptionText: cleanHtml(
      typeof raw.descriptionPlain === "string" ? raw.descriptionPlain : "",
      ["collapse"],
    ),
    applyUrl,
    postedAt,
    raw,
  };
}

/** Prefer the multi-office `categories.allLocations`; fall back to `categories.location`. */
function extractLocations(categories: Record<string, unknown> | undefined): string[] {
  if (!categories) return [];
  if (Array.isArray(categories.allLocations)) {
    const all = categories.allLocations
      .filter((l): l is string => typeof l === "string")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (all.length > 0) return all;
  }
  if (typeof categories.location === "string" && categories.location.trim()) {
    return [categories.location.trim()];
  }
  return [];
}
