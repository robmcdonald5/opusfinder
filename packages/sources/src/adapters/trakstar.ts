import { companySlug, isRecord, jobId } from "@opusfinder/shared";
import type { NormalizedJob } from "@opusfinder/shared";

import { inferRemoteFromText, joinParts } from "./fields";
import { htmlToText } from "./text";
import type { Cursor, SourceAdapter, SourceContext } from "./types";

const API = "https://jsapi.recruiterbox.com/v1/openings/";

// The server's default page size (meta.limit when unspecified): the explicit page size sent in
// the request URL and used by the full-page termination check. meta.total is the authoritative
// count; nextCursor advances by the actual page-item count, not this constant.
const PAGE_LIMIT = 20;

/**
 * Trakstar Hire (Recruiterbox) adapter (Phase 6.5 Wave A). The board API is OFFSET-paginated
 * via `&limit=&offset=` over `{ meta: { offset, limit, total }, objects: [...] }`, which maps
 * directly onto the existing `{ kind: "offset" }` Cursor — no new Cursor member. Descriptions
 * are inline (no hydrate).
 *
 * Quirks: the host is case-INSENSITIVE and echoes `client_name` lowercased, so `normalizeSlug`
 * lowercases to the canonical form. `id` is already a string (e.g. "fk0745"). `location` is a
 * single OBJECT (`{ city, state, country, zipcode }`), composed into one string. `remote` is
 * the structured `allows_remote` (true | false | null) — `true`/`false` are BOTH authoritative;
 * only `null`/absent infers from the location text (no "Hybrid" string exists, so no Hybrid trap). There is NO
 * posted/created date (only `close_date`, an EXPIRY date), so `postedAt` is always null. An
 * unknown slug returns HTTP 400 (handled loud by runAdapter); a real-but-empty board returns
 * 200 with `meta.total: 0`.
 */
export const trakstarAdapter: SourceAdapter = {
  source: "trakstar",

  // Lowercase: the host is case-insensitive and echoes client_name lowercased; the apply URL
  // is an explicit field (reconstruction also uses the lowercased slug), so lowercasing is safe.
  normalizeSlug: (rawSlug) => companySlug(rawSlug.toLowerCase()),

  jobsRequest: (ctx, cursor) => {
    const offset = cursor ? cursor.offset : 0;
    return { url: `${API}?client_name=${ctx.slug}&limit=${PAGE_LIMIT}&offset=${offset}` };
  },

  locate: (body, ctx) => {
    if (!isRecord(body) || !Array.isArray(body.objects)) {
      throw new Error(`Trakstar returned an unexpected response shape for "${ctx.slug}"`);
    }
    return body.objects;
  },

  // Advance by the actual page size (robust to a server clamp). An empty page always
  // terminates. With a usable `meta.total`, stop once the window covers it; without one (API
  // drift), keep going while pages are full and let the short/empty page terminate (the server
  // honors offset). Mirrors the SmartRecruiters defensive shape.
  nextCursor: (body, prevCursor, pageItemCount): Cursor | null => {
    if (pageItemCount === 0) return null;
    const offset = (prevCursor ? prevCursor.offset : 0) + pageItemCount;
    const meta = isRecord(body) && isRecord(body.meta) ? body.meta : undefined;
    const total =
      meta && typeof meta.total === "number" && Number.isFinite(meta.total)
        ? meta.total
        : undefined;
    if (total !== undefined) {
      return offset >= total ? null : { kind: "offset", offset };
    }
    return pageItemCount < PAGE_LIMIT ? null : { kind: "offset", offset };
  },

  mapItem: (raw, ctx) => toNormalizedJob(raw, ctx),
};

function toNormalizedJob(raw: unknown, ctx: SourceContext): NormalizedJob | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) return null;
  if (typeof raw.title !== "string") return null;

  // Brand once and reuse for the reconstructed apply URL, so the URL uses the same trimmed id.
  const externalId = jobId(raw.id);

  // hosted_url is provided inline; reconstruct from the canonical pattern only if it is absent
  // (the lowercased slug is the subdomain, matching the echoed client_name).
  const applyUrl =
    typeof raw.hosted_url === "string" && raw.hosted_url
      ? raw.hosted_url
      : `https://${ctx.slug}.hire.trakstar.com/jobs/${externalId}/`;

  const locations = extractLocations(raw.location);

  // Structured `allows_remote` (true | false | null): `true`/`false` are BOTH authoritative
  // (matching the sibling enum adapters — an explicit non-remote value must not be overridden by
  // location text); only `null`/absent infers from the text. No "Hybrid" value exists.
  const remote =
    raw.allows_remote === true
      ? true
      : raw.allows_remote === false
        ? false
        : inferRemoteFromText(locations);

  return {
    source: "trakstar",
    externalId,
    title: raw.title,
    companySlug: ctx.slug,
    locations,
    remote,
    // `description` is raw HTML tags + SINGLE-encoded entities: strip → decode once → collapse.
    // It can legitimately be "" (some postings carry no body) — cleanHtml returns "" safely.
    descriptionText: htmlToText(raw.description),
    applyUrl,
    // No posted/created date — only close_date (an EXPIRY date), which must NOT be used.
    postedAt: null,
    raw,
  };
}

/**
 * Compose a single location string from the `location` OBJECT's city/state/country (skipping
 * empties; zipcode intentionally dropped). `[]` when location is absent or all-empty.
 */
function extractLocations(loc: unknown): string[] {
  if (!isRecord(loc)) return [];
  const composed = joinParts([loc.city, loc.state, loc.country]);
  return composed ? [composed] : [];
}
