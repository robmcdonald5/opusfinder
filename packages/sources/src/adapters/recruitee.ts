import { companySlug, isRecord, jobId } from "@opusfinder/shared";
import type { NormalizedJob } from "@opusfinder/shared";

import { inferRemoteFromText } from "./fields";
import { htmlToText } from "./text";
import type { SourceAdapter, SourceContext } from "./types";

const RECRUITEE_HOST = "recruitee.com";

/**
 * Recruitee careers-site adapter (Phase 6.5 Wave A). Each tenant is a subdomain
 * (`{slug}.recruitee.com`) and the public `/api/offers/` returns the whole board in one
 * `{ offers: [...] }` response — no pagination (`nextCursor` omitted), descriptions inline
 * (no hydrate). The endpoint already returns only published offers.
 *
 * Quirks: the host is case-INSENSITIVE, so `normalizeSlug` lowercases for clean Phase-7
 * dedupe (the apply URL is an explicit field, so lowercasing can't corrupt it). `id` is a
 * NUMBER (stringify before `jobId`). `remote` is THREE independent booleans
 * (`remote`/`hybrid`/`on_site`) that can co-occur — `remote:true` ships alongside `hybrid:true`
 * on real postings — so `hybrid` is checked FIRST (Hybrid ⇒ false per the contract). The
 * top-level `location` string is primary-office only and can disagree with the multi-office
 * `locations[]`, so locations prefer `locations[].name`. `published_at` is
 * `"YYYY-MM-DD HH:MM:SS UTC"` (NOT ISO-8601) and is massaged to ISO so parsing is engine-
 * independent (Worker-forward, Phase 8). Apply URL is `careers_apply_url`, falling back to the
 * listing `careers_url` VERBATIM — never reconstructed (custom careers domains exist).
 */
export const recruiteeAdapter: SourceAdapter = {
  source: "recruitee",

  // Lowercase: the subdomain host is case-insensitive and the apply URL is an explicit field
  // (never slug-derived), so lowercasing canonicalizes safely (same rationale as Workable).
  normalizeSlug: (rawSlug) => companySlug(rawSlug.toLowerCase()),

  jobsRequest: (ctx) => ({ url: `https://${ctx.slug}.${RECRUITEE_HOST}/api/offers/` }),

  locate: (body, ctx) => {
    if (!isRecord(body) || !Array.isArray(body.offers)) {
      throw new Error(`Recruitee returned an unexpected response shape for "${ctx.slug}"`);
    }
    return body.offers;
  },

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
    // `description` is raw HTML tags + SINGLE-encoded entities: strip → decode once → collapse.
    // The separate `requirements` field (same encoding, board-dependent) stays on `raw`
    // (primary body only for now; revisit under the Phase-5 eval).
    descriptionText: htmlToText(raw.description),
    applyUrl,
    postedAt: parsePublishedAt(raw.published_at),
    raw,
  };
}

/**
 * Prefer the multi-office `locations[].name`; fall back to the primary-office top-level
 * `location` string. Each value is kept verbatim (no parsing). `[]` when neither is present.
 */
function extractLocations(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (Array.isArray(raw.locations)) {
    for (const loc of raw.locations) {
      if (isRecord(loc) && typeof loc.name === "string" && loc.name.trim()) {
        out.push(loc.name.trim());
      }
    }
  }
  if (out.length === 0 && typeof raw.location === "string" && raw.location.trim()) {
    out.push(raw.location.trim());
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
