import { companySlug, isRecord, jobId } from "@opusfinder/shared";
import type { NormalizedJob } from "@opusfinder/shared";

import { inferRemoteFromText, joinParts } from "./fields";
import { htmlToText } from "./text";
import type { SourceAdapter, SourceContext } from "./types";

const POSTINGS_HOST = "pinpointhq.com";

/**
 * Pinpoint job-board adapter (Phase 6.5 Wave A). Each tenant is a subdomain
 * (`{slug}.pinpointhq.com`) and the public `postings.json` returns the WHOLE board in one
 * `{ data: [...] }` response — no pagination (the `?page` param is silently IGNORED, so a
 * naive page loop would never terminate; `nextCursor` is omitted). Descriptions are inline,
 * so no hydrate.
 *
 * Quirks: the host is case-INSENSITIVE and the apply URL is an explicit `url` field (NOT
 * reconstructed from the slug), so `normalizeSlug` lowercases for clean Phase-7 dedupe (same
 * rationale as Workable). The posting `id` is a STRING — distinct from the nested `job.id`
 * AND from the UUID in `url`. `location.name` is an internal office LABEL (sometimes literally
 * "Remote") — a trap — so locations compose from `location.city` + `location.province` and
 * `remote` comes from the structured `workplace_type` enum. There is NO posted/created date on
 * the posting (only `deadline_at`, an application-CLOSE date), so `postedAt` is always null.
 */
export const pinpointAdapter: SourceAdapter = {
  source: "pinpoint",

  // Lowercase: the subdomain host is case-insensitive and the apply URL is an explicit field
  // (never slug-derived), so lowercasing canonicalizes without corrupting any echoed casing.
  normalizeSlug: (rawSlug) => companySlug(rawSlug.toLowerCase()),

  jobsRequest: (ctx) => ({ url: `https://${ctx.slug}.${POSTINGS_HOST}/postings.json` }),

  locate: (body, ctx) => {
    // body holds rich sibling sections; only body.data is the postings array.
    if (!isRecord(body) || !Array.isArray(body.data)) {
      throw new Error(`Pinpoint returned an unexpected response shape for "${ctx.slug}"`);
    }
    return body.data;
  },

  mapItem: (raw, ctx) => toNormalizedJob(raw, ctx),
};

function toNormalizedJob(raw: unknown, ctx: SourceContext): NormalizedJob | null {
  if (!isRecord(raw)) return null;
  // Posting `id` is a string and is DISTINCT from the nested job.id and the url UUID.
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) return null;
  if (typeof raw.title !== "string") return null;

  // Apply URL is the explicit `url` (UUID-based, with an /en/ locale segment).
  const applyUrl = typeof raw.url === "string" && raw.url ? raw.url : "";
  if (!applyUrl) return null;

  const locations = extractLocations(raw.location);

  // Structured `workplace_type` (lowercase enum): "remote" ⇒ true; "hybrid"/"onsite" ⇒ false.
  // Anything else (absent/unknown) infers from the location text. Do NOT trust
  // location.name === "Remote" — it is an unreliable office label, not a remote signal.
  const workplaceType = typeof raw.workplace_type === "string" ? raw.workplace_type : "";
  const remote =
    workplaceType === "remote"
      ? true
      : workplaceType === "hybrid" || workplaceType === "onsite"
        ? false
        : inferRemoteFromText(locations);

  return {
    source: "pinpoint",
    externalId: jobId(raw.id),
    title: raw.title,
    companySlug: ctx.slug,
    locations,
    remote,
    // `description` is raw HTML tags (incl. <!--block--> markers, removed by the tag regex)
    // plus SINGLE-encoded entities: strip → decode once → collapse. The richer
    // key_responsibilities / skills_knowledge_expertise / benefits sections stay on `raw`
    // (primary body only for now; revisit under the Phase-5 eval).
    descriptionText: htmlToText(raw.description),
    applyUrl,
    // No posted/created date on the posting — only deadline_at (an application-CLOSE date),
    // which must NOT be used. postedAt is therefore always null (contract-valid).
    postedAt: null,
    raw,
  };
}

/**
 * Compose a single location string from the nested `location` object's city + province
 * (skipping empties). `location.name` is intentionally NOT used — it is an internal office
 * label, not clean geography. `[]` when neither part is present.
 */
function extractLocations(loc: unknown): string[] {
  if (!isRecord(loc)) return [];
  const composed = joinParts([loc.city, loc.province]);
  return composed ? [composed] : [];
}
