import { companySlug, isRecord, jobId } from "@opusfinder/shared";
import type { NormalizedJob } from "@opusfinder/shared";

import { joinParts } from "./fields";
import { cleanHtml } from "./text";
import type { Cursor, FetchJson, SourceAdapter, SourceContext } from "./types";

const API = "https://api.smartrecruiters.com/v1/companies";
const PUBLIC = "https://jobs.smartrecruiters.com";

// SmartRecruiters clamps `limit` at 100 server-side; 100 minimizes round-trips.
const PAGE_LIMIT = 100;
// Fixed concatenation order for description sections: iterating Object.keys would make
// re-ingest look "changed" (needlessly NULLing the embedding) when the API reorders keys.
const SECTION_ORDER = [
  "companyDescription",
  "jobDescription",
  "qualifications",
  "additionalInformation",
] as const;

/**
 * SmartRecruiters company adapter — the only Launch-5 source that is BOTH offset-paginated
 * AND requires an N+1 hydrate. The list item carries neither a description nor a public
 * apply URL, so `mapItem` emits a fully-valid job (reconstructed apply URL, empty
 * description) that `hydrate` then patches; a hydrate failure therefore keeps a usable job.
 * Company IDs are case-sensitive, so `normalizeSlug` preserves casing.
 *
 * Pagination uses `body.totalFound`; `nextCursor` and `locate` both read the same envelope
 * (one is the array, the other the count) — an accepted seam. NOTE for Phase 7: an unknown
 * slug returns 200 + `totalFound:0` (NOT 404), so slug existence cannot be asserted here.
 */
export const smartRecruitersAdapter: SourceAdapter = {
  source: "smartrecruiters",

  // Case-sensitive company IDs: trim only, never lowercase.
  normalizeSlug: (rawSlug) => companySlug(rawSlug),

  jobsRequest: (ctx, cursor) => {
    const offset = cursor ? cursor.offset : 0;
    return { url: `${API}/${ctx.slug}/postings?limit=${PAGE_LIMIT}&offset=${offset}` };
  },

  locate: (body, ctx) => {
    if (!isRecord(body) || !Array.isArray(body.content)) {
      throw new Error(`SmartRecruiters returned an unexpected response shape for "${ctx.slug}"`);
    }
    return body.content;
  },

  // Advance by the actual page size (robust to the server's limit clamp). An empty page
  // always terminates. With a usable `totalFound`, stop once the window covers it; without
  // one (API drift), do NOT stop early and silently truncate — keep going while pages are
  // full and let the short/empty page be the terminator (the server respects offset, so it
  // arrives), which also can't loop forever.
  nextCursor: (body, prevCursor, pageItemCount): Cursor | null => {
    if (pageItemCount === 0) return null;
    const offset = (prevCursor ? prevCursor.offset : 0) + pageItemCount;
    const totalFound =
      isRecord(body) && typeof body.totalFound === "number" && Number.isFinite(body.totalFound)
        ? body.totalFound
        : undefined;
    if (totalFound !== undefined) {
      return offset >= totalFound ? null : { kind: "offset", offset, limit: PAGE_LIMIT };
    }
    return pageItemCount < PAGE_LIMIT ? null : { kind: "offset", offset, limit: PAGE_LIMIT };
  },

  mapItem: (raw, ctx) => toNormalizedJob(raw, ctx),

  hydrate: (job, _raw, ctx, fetchJson) => hydratePosting(job, ctx, fetchJson),
};

/**
 * Map ONE raw list item to a fully-valid job (apply URL reconstructed from the public
 * pattern, description empty — both patched by hydrate). Producing a valid job here is what
 * lets a hydrate failure be non-fatal. List fields: `id`, `name`, `location`, `releasedDate`.
 */
function toNormalizedJob(raw: unknown, ctx: SourceContext): NormalizedJob | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) return null;
  if (typeof raw.name !== "string") return null;

  // Brand once and reuse for the reconstructed apply URL, so the URL uses the same
  // trimmed/validated id as externalId (not the raw, possibly space-padded value).
  const externalId = jobId(raw.id);

  let postedAt: Date | null = null;
  if (typeof raw.releasedDate === "string" && raw.releasedDate) {
    const parsed = new Date(raw.releasedDate);
    postedAt = Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return {
    source: "smartrecruiters",
    externalId,
    title: raw.name,
    companySlug: ctx.slug,
    locations: extractLocation(raw.location),
    remote: isRemoteLocation(raw.location),
    descriptionText: "",
    applyUrl: `${PUBLIC}/${ctx.slug}/${externalId}`, // hydrate overwrites with the real applyUrl
    postedAt,
    raw,
  };
}

/**
 * SmartRecruiters structured remote flag: only `location.remote === true`. `location.hybrid`
 * is a DISTINCT signal mapping to remote=false per the NormalizedJob contract, so it is
 * intentionally ignored. Shared by the list mapItem and the hydrate refresh.
 */
function isRemoteLocation(loc: unknown): boolean {
  return isRecord(loc) && loc.remote === true;
}

/**
 * The N+1 hydrate (one fetch per posting, via the injected resilient `fetchJson`). Fills
 * `descriptionText` from the jobAd sections (HTML → plain text), the real `applyUrl`, and
 * replaces `raw` with the FULL hydrated posting (a superset of the list item) so nothing
 * is lost — required for a lossless `raw` payload.
 */
async function hydratePosting(
  job: NormalizedJob,
  ctx: SourceContext,
  fetchJson: FetchJson,
): Promise<Partial<NormalizedJob>> {
  const detail = await fetchJson({ url: `${API}/${ctx.slug}/postings/${job.externalId}` });
  // A non-object detail (valid JSON null/string from an edge/maintenance response) carries
  // nothing to patch — keep the valid pre-hydrate job (list-item raw, reconstructed apply
  // URL, list-derived remote) rather than clobbering raw with the garbage.
  if (!isRecord(detail)) return {};

  const patch: Partial<NormalizedJob> = { raw: detail };

  const sections =
    isRecord(detail.jobAd) && isRecord(detail.jobAd.sections) ? detail.jobAd.sections : undefined;
  patch.descriptionText = sections ? cleanSections(sections) : "";

  const applyUrl =
    (typeof detail.applyUrl === "string" && detail.applyUrl) ||
    (typeof detail.postingUrl === "string" && detail.postingUrl) ||
    "";
  if (applyUrl) patch.applyUrl = applyUrl;

  // The detail is the authoritative full posting — refresh `remote` from its location when
  // present (covers a board whose list item omits the flag but whose detail carries it).
  if (isRecord(detail.location)) patch.remote = isRemoteLocation(detail.location);

  return patch;
}

/** Concatenate the description sections in a stable order, each cleaned to plain text. */
function cleanSections(sections: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of SECTION_ORDER) {
    const section = sections[key];
    const text = isRecord(section) && typeof section.text === "string" ? section.text : "";
    // jobAd section text is RAW tags + single-encoded entities: strip → decode once → collapse.
    const cleaned = cleanHtml(text, ["strip", "decode", "collapse"]);
    if (cleaned) parts.push(cleaned);
  }
  return parts.join("\n\n");
}

/** Prefer `location.fullLocation`; else compose city/region/country. Single-element array. */
function extractLocation(loc: unknown): string[] {
  if (!isRecord(loc)) return [];
  if (typeof loc.fullLocation === "string" && loc.fullLocation.trim()) {
    return [loc.fullLocation.trim()];
  }
  const composed = joinParts([loc.city, loc.region, loc.country]);
  return composed ? [composed] : [];
}
