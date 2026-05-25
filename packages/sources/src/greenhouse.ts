import { companySlug, jobId } from "@opusfinder/shared";
import type { CompanySlug, NormalizedJob } from "@opusfinder/shared";

const BOARDS_API = "https://boards-api.greenhouse.io/v1/boards";

/**
 * Fetch and normalize all live postings for one Greenhouse board.
 *
 * The board API returns every posting in a single response (it is NOT
 * paginated), so this is one fetch with no cursor loop. No retries/backoff in
 * Phase 1 — that plumbing is extracted in Phase 6 alongside the second adapter.
 *
 * Each posting is normalized independently; a malformed one is skipped (logged),
 * not fatal, so a single bad entry can't abort ingestion for the whole board.
 */
export async function fetchJobs(slug: string): Promise<NormalizedJob[]> {
  // Greenhouse board tokens are lowercase, so canonicalize HERE, before branding.
  // companySlug() only enforces the universal floor and must not change casing
  // (Phase 6 SmartRecruiters IDs are case-sensitive); the per-source rule lives here.
  const token: CompanySlug = companySlug(slug.toLowerCase());

  const res = await fetch(`${BOARDS_API}/${token}/jobs?content=true`);
  if (!res.ok) {
    // Release the unconsumed response stream so no socket handle lingers (lets the
    // caller's process exit cleanly). Ignore cancel errors — we're already failing.
    await res.body?.cancel().catch(() => {});
    throw new Error(`Greenhouse fetch failed for "${token}": ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as unknown;

  const jobs: NormalizedJob[] = [];
  let skipped = 0;
  for (const raw of extractJobs(body, token)) {
    const job = toNormalizedJob(raw, token);
    if (job) jobs.push(job);
    else skipped++;
  }
  if (skipped > 0) {
    console.warn(`Greenhouse "${token}": skipped ${skipped} malformed posting(s).`);
  }
  return jobs;
}

/** Validate the response envelope is `{ jobs: [...] }`; elements stay untrusted. */
function extractJobs(body: unknown, token: CompanySlug): unknown[] {
  if (!isRecord(body) || !Array.isArray(body.jobs)) {
    throw new Error(`Greenhouse returned an unexpected response shape for "${token}"`);
  }
  return body.jobs;
}

/**
 * Map ONE raw Greenhouse posting to a NormalizedJob, or `null` if it lacks the
 * fields we require (the caller skips it rather than aborting the board). The
 * fetch body is `unknown`, so every field is checked here — the network shape is
 * never trusted.
 *
 * Greenhouse fields used: `id` (number), `title`, `absolute_url`, `location.name`
 * (or null), `first_published` / `updated_at` (ISO-8601), `content` (HTML, present
 * with `?content=true`). Everything is retained verbatim on `raw`.
 */
function toNormalizedJob(raw: unknown, token: CompanySlug): NormalizedJob | null {
  if (!isRecord(raw)) return null;
  const { id, title, absolute_url } = raw;
  if (typeof id !== "number" || !Number.isFinite(id)) return null;
  if (typeof title !== "string" || typeof absolute_url !== "string") return null;

  const locationName =
    isRecord(raw.location) && typeof raw.location.name === "string" ? raw.location.name.trim() : "";

  // `||` (not `??`): an empty-string date should fall back to updated_at, not be
  // kept. Guard against an Invalid Date so a bad value becomes null rather than
  // detonating at the Phase 2 timestamptz insert.
  const dateText =
    (typeof raw.first_published === "string" ? raw.first_published : "") ||
    (typeof raw.updated_at === "string" ? raw.updated_at : "");
  const parsed = dateText ? new Date(dateText) : null;
  const postedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;

  return {
    source: "greenhouse",
    externalId: jobId(String(id)),
    title,
    companySlug: token,
    // Greenhouse exposes one display string; richer multi-office handling is deferred.
    locations: locationName ? [locationName] : [],
    // No structured remote flag; infer from the location string. "" → false, and
    // "Hybrid - …" stays false unless it literally contains the word "remote".
    remote: /\bremote\b/i.test(locationName),
    descriptionText: decodeDescription(typeof raw.content === "string" ? raw.content : ""),
    applyUrl: absolute_url,
    postedAt,
    raw,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Greenhouse `content` arrives DOUBLE-entity-encoded: structural tags as a
 * single layer (`&lt;div&gt;`) and inner text entities as two layers
 * (`&amp;nbsp;`, `&amp;#39;`). To get plain text the decode must happen BEFORE
 * stripping — stripping first finds no real `<…>` tags and would ship entity soup.
 *
 *   1. decode once  → real tags appear (`<div>`); text entities peel one layer
 *   2. strip tags   → remove the now-real markup
 *   3. decode again → peel the inner text entities (`&nbsp;` → " ", `&#39;` → ')
 *   4. collapse     → squeeze whitespace runs (JS \s also matches U+00A0)
 */
function decodeDescription(content: string): string {
  const stripped = decodeEntities(content).replace(/<[^>]*>/g, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode ONE layer of HTML entities: the common named set + numeric dec/hex. */
function decodeEntities(input: string): string {
  return input.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match: string, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? Number.parseInt(ref.slice(2), 16)
          : Number.parseInt(ref.slice(1), 10);
      return decodeCodePoint(code, match);
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
  });
}

/**
 * A numeric code point → its character, or `fallback` (the raw entity text) for
 * anything that would crash or yield invalid/unsafe text: out-of-range values
 * (`String.fromCodePoint` throws above 0x10FFFF), lone surrogates (ill-formed
 * UTF-16), and C0 control chars other than tab/newline/CR (e.g. a NUL that a
 * downstream text column would reject).
 */
function decodeCodePoint(code: number, fallback: string): string {
  if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return fallback;
  }
  if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
    return fallback;
  }
  return String.fromCodePoint(code);
}
