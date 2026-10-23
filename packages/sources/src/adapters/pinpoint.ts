import { companySlug, isRecord, safeJobId } from "@opusfinder/shared";
import type { NormalizedJob } from "@opusfinder/shared";

import { inferRemoteFromText, joinParts } from "./fields";
import { htmlToText, joinSections } from "./text";
import type { SourceAdapter, SourceContext } from "./types";
import { subdomainLabel } from "./url-match";

const POSTINGS_HOST = "pinpointhq.com";

/**
 * Pinpoint job-board adapter. Each tenant is a subdomain (`{slug}.pinpointhq.com`) and the
 * public `postings.json` returns the WHOLE board in one `{ data: [...] }` response — no
 * pagination (the `?page` param is silently IGNORED, so a naive page loop would never terminate;
 * `nextCursor` is omitted). Descriptions are inline, so no hydrate.
 *
 * Quirks: the host is case-INSENSITIVE and the apply URL is an explicit `url` field (NOT
 * reconstructed from the slug), so `normalizeSlug` lowercases. The posting `id` is a STRING —
 * distinct from the nested `job.id` AND from the UUID in `url`. `location.name` is an internal
 * office LABEL (sometimes literally "Remote") — a trap — so locations compose from `location.city`
 * + `location.province` and `remote` comes from the structured `workplace_type` enum. There is NO
 * posted/created date on the posting (only `deadline_at`, an application-CLOSE date), so `postedAt`
 * is always null.
 */
export const pinpointAdapter: SourceAdapter = {
  source: "pinpoint",

  // Lowercase: the subdomain host is case-insensitive and the apply URL is an explicit field
  // (never slug-derived), so lowercasing canonicalizes without corrupting any echoed casing.
  normalizeSlug: (rawSlug) => companySlug(rawSlug.toLowerCase()),

  // {slug}.pinpointhq.com → the tenant subdomain label.
  matchUrl: (url) => subdomainLabel(url, POSTINGS_HOST),

  jobsRequest: (ctx) => ({ url: `https://${ctx.slug}.${POSTINGS_HOST}/postings.json` }),

  // body holds rich sibling sections; only body.data is the postings array.
  itemsKey: "data",

  mapItem: (raw, ctx) => toNormalizedJob(raw, ctx),
};

function toNormalizedJob(raw: unknown, ctx: SourceContext): NormalizedJob | null {
  if (!isRecord(raw)) return null;
  // Posting `id` is a string and is DISTINCT from the nested job.id and the url UUID.
  const externalId = safeJobId(raw.id);
  if (externalId === null) return null;
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
    externalId,
    title: raw.title,
    companySlug: ctx.slug,
    locations,
    remote,
    // `description` plus the responsibilities and skills sections, each raw HTML tags (incl.
    // <!--block--> markers, removed by the strip) plus SINGLE-encoded entities: strip → decode
    // once → collapse. The `benefits` section is left out: it says nothing about fit.
    descriptionText: joinSections([
      htmlToText(raw.description),
      htmlToText(raw.key_responsibilities),
      htmlToText(raw.skills_knowledge_expertise),
    ]),
    applyUrl,
    // No posted/created date on the posting — only deadline_at (an application-CLOSE date),
    // which must NOT be used. postedAt is therefore always null (contract-valid).
    postedAt: null,
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
