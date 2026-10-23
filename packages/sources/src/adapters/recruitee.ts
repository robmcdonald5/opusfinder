import { companySlug, isRecord, jobId } from "@opusfinder/shared";
import type { NormalizedJob } from "@opusfinder/shared";

import { inferRemoteFromText, joinParts } from "./fields";
import { htmlToText, joinSections } from "./text";
import type { SourceAdapter, SourceContext } from "./types";
import { subdomainLabel } from "./url-match";

const RECRUITEE_HOST = "recruitee.com";

/**
 * Recruitee careers-site adapter. Each tenant is a subdomain (`{slug}.recruitee.com`) and the
 * public `/api/offers/` returns the whole board in one `{ offers: [...] }` response — no
 * pagination (`nextCursor` omitted), descriptions inline (no hydrate). The endpoint already
 * returns only published offers.
 *
 * Quirks: the host is case-INSENSITIVE, so `normalizeSlug` lowercases (the apply URL is an
 * explicit field, so lowercasing can't corrupt it). `id` is a NUMBER (stringify before `jobId`).
 * `remote` is three independent booleans (see mapItem); locations compose each multi-office
 * `locations[]` entry (see extractLocations); `published_at` is massaged to ISO (see
 * parsePublishedAt). Apply URL is `careers_apply_url`, falling back to the listing `careers_url`
 * VERBATIM — never reconstructed (custom careers domains exist).
 */
export const recruiteeAdapter: SourceAdapter = {
  source: "recruitee",

  // Lowercase: the subdomain host is case-insensitive and the apply URL is an explicit field
  // (never slug-derived), so lowercasing canonicalizes safely (same rationale as Workable).
  normalizeSlug: (rawSlug) => companySlug(rawSlug.toLowerCase()),

  // {slug}.recruitee.com → the tenant subdomain label.
  matchUrl: (url) => subdomainLabel(url, RECRUITEE_HOST),

  jobsRequest: (ctx) => ({ url: `https://${ctx.slug}.${RECRUITEE_HOST}/api/offers/` }),

  itemsKey: "offers",

  mapItem: (raw, ctx) => toNormalizedJob(raw, ctx),
};

function toNormalizedJob(raw: unknown, ctx: SourceContext): NormalizedJob | null {
  if (!isRecord(raw)) return null;
  // `id` is a number (stringify before branding).
  if (typeof raw.id !== "number" || !Number.isFinite(raw.id)) return null;
  if (typeof raw.title !== "string") return null;

  const applyUrl =
    (typeof raw.careers_apply_url === "string" && raw.careers_apply_url) ||
    (typeof raw.careers_url === "string" && raw.careers_url) ||
    "";
  if (!applyUrl) return null;

  const locations = extractLocations(raw);

  // Three INDEPENDENT booleans that can co-occur (remote:true + hybrid:true on real postings).
  // Check hybrid FIRST so a hybrid posting resolves to false per the NormalizedJob contract;
  // then remote ⇒ true, then on_site ⇒ false; else infer from the location text.
  const remote =
    raw.hybrid === true
      ? false
      : raw.remote === true
        ? true
        : raw.on_site === true
          ? false
          : inferRemoteFromText(locations);

  return {
    source: "recruitee",
    externalId: jobId(String(raw.id)),
    title: raw.title,
    companySlug: ctx.slug,
    locations,
    remote,
    // `description` and `requirements` are raw HTML tags + SINGLE-encoded entities (strip → decode once → collapse).
    descriptionText: joinSections([htmlToText(raw.description), htmlToText(raw.requirements)]),
    applyUrl,
    postedAt: parsePublishedAt(raw.published_at),
  };
}

/**
 * One string per multi-office `locations[]` entry, composed from its city/state/country. Its `name` is
 * a free-form office label (often a bare city, so the country would be lost), used only when those
 * parts are empty. Falls back to the primary-office top-level `location` string. `[]` when neither
 * is present.
 */
function extractLocations(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (Array.isArray(raw.locations)) {
    for (const loc of raw.locations) {
      if (!isRecord(loc)) continue;
      const composed = joinParts([loc.city, loc.state, loc.country]) || joinParts([loc.name]);
      if (composed) out.push(composed);
    }
  }
  if (out.length === 0) {
    const flat = joinParts([raw.location]);
    if (flat) out.push(flat);
  }
  return out;
}

/**
 * Parse Recruitee's `"YYYY-MM-DD HH:MM:SS UTC"` timestamp. It is NOT ISO-8601, so it is
 * massaged to ISO (` UTC` → `Z`, the date/time space → `T`) before `new Date()` — V8 accepts
 * the raw form but a Cloudflare Worker may not, and this code must run unchanged there.
 */
function parsePublishedAt(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Massage the trimmed value (NOT the raw one): trimming first avoids a leading space being
  // turned into the date/time `T` by the single-space replace below.
  const iso = trimmed.replace(" UTC", "Z").replace(" ", "T");
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
