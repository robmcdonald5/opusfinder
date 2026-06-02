import { companySlug, isRecord, jobId } from "@opusfinder/shared";
import type { NormalizedJob } from "@opusfinder/shared";

import { cleanHtml } from "./text";
import type { SourceAdapter, SourceContext } from "./types";

const BOARDS_API = "https://boards-api.greenhouse.io/v1/boards";

/**
 * Greenhouse board adapter (the Phase-1 reference, now a descriptor). The board API
 * returns every posting in one `{ jobs, meta }` response, so there is no pagination
 * (`nextCursor` omitted) and no hydration. Board tokens are lowercase, so `normalizeSlug`
 * lowercases before branding.
 */
export const greenhouseAdapter: SourceAdapter = {
  source: "greenhouse",

  // Board tokens are lowercase; companySlug() only enforces the universal floor and must
  // not change casing (case-sensitive platforms like SmartRecruiters rely on that), so the
  // per-source lowercasing lives here.
  normalizeSlug: (rawSlug) => companySlug(rawSlug.toLowerCase()),

  jobsRequest: (ctx) => ({ url: `${BOARDS_API}/${ctx.slug}/jobs?content=true` }),

  locate: (body, ctx) => {
    if (!isRecord(body) || !Array.isArray(body.jobs)) {
      throw new Error(`Greenhouse returned an unexpected response shape for "${ctx.slug}"`);
    }
    return body.jobs;
  },

  mapItem: (raw, ctx) => toNormalizedJob(raw, ctx),
};

/**
 * Greenhouse fields used: `id` (number), `title`, `absolute_url`, `location.name`,
 * `first_published` / `updated_at` (ISO), `content` (HTML, present with `?content=true`).
 */
function toNormalizedJob(raw: unknown, ctx: SourceContext): NormalizedJob | null {
  if (!isRecord(raw)) return null;
  const { id, title, absolute_url } = raw;
  if (typeof id !== "number" || !Number.isFinite(id)) return null;
  if (typeof title !== "string" || typeof absolute_url !== "string") return null;

  const locationName =
    isRecord(raw.location) && typeof raw.location.name === "string" ? raw.location.name.trim() : "";

  // `||` (not `??`): an empty-string date should fall back to updated_at, not be kept.
  const dateText =
    (typeof raw.first_published === "string" ? raw.first_published : "") ||
    (typeof raw.updated_at === "string" ? raw.updated_at : "");
  const parsed = dateText ? new Date(dateText) : null;
  const postedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;

  return {
    source: "greenhouse",
    externalId: jobId(String(id)),
    title,
    companySlug: ctx.slug,
    locations: locationName ? [locationName] : [],
    remote: /\bremote\b/i.test(locationName),
    // `content` is DOUBLE-entity-encoded (structural tags single-encoded, inner text
    // entities double-encoded), so the pipeline is decode → strip → decode → collapse.
    descriptionText: cleanHtml(typeof raw.content === "string" ? raw.content : "", [
      "decode",
      "strip",
      "decode",
      "collapse",
    ]),
    applyUrl: absolute_url,
    postedAt,
    raw,
  };
}
