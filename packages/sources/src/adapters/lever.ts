import { companySlug, isRecord, safeJobId } from "@opusfinder/shared";
import type { NormalizedJob } from "@opusfinder/shared";

import { inferRemoteFromText } from "./fields";
import { cleanHtml, htmlToText, joinSections } from "./text";
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
  const externalId = safeJobId(raw.id);
  if (externalId === null) return null;
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
    externalId,
    title: raw.text,
    companySlug: ctx.slug,
    locations,
    remote,
    descriptionText: describePosting(raw),
    applyUrl,
    postedAt,
  };
}

/**
 * The posting text in page order: `descriptionPlain` (opening + body only), each `lists[]` section
 * (requirements, responsibilities, benefits: a plain heading plus HTML list items), the salary note,
 * then the `additionalPlain` closing. The `*Plain` fields are pre-stripped, so they only collapse.
 */
function describePosting(raw: Record<string, unknown>): string {
  const plain = (value: unknown) => cleanHtml(typeof value === "string" ? value : "", ["collapse"]);
  const body = [plain(raw.descriptionPlain)];
  if (Array.isArray(raw.lists)) {
    for (const list of raw.lists) {
      if (!isRecord(list)) continue;
      const items = htmlToText(list.content);
      const heading = plain(list.text);
      if (items) body.push(heading ? `${heading}\n${items}` : items);
    }
  }
  // The salary note and closing (often EEO boilerplate) only extend a body: alone they'd overwrite the
  // stored text through a blank fetch, which upsertJobs' blank-description guard otherwise keeps.
  if (!body.some((section) => section.length > 0)) return "";
  return joinSections([...body, plain(raw.salaryDescriptionPlain), plain(raw.additionalPlain)]);
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
