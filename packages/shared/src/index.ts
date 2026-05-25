declare const __brand: unique symbol;
type Brand<TBase, TBrand extends string> = TBase & { readonly [__brand]: TBrand };

/** A URL-safe company identifier, e.g. "acme-corp" or "SmartRecruitersInc". */
export type CompanySlug = Brand<string, "CompanySlug">;

/** A canonical job posting identifier (numeric, UUID, or opaque token, per ATS). */
export type JobId = Brand<string, "JobId">;

/**
 * UNIVERSAL slug floor — invariants true for every ATS: non-empty, no
 * whitespace, URL-path-safe (so a slug can be dropped into a request path
 * without injection). Deliberately permits mixed case and `_`/`.` because slug
 * shape differs across platforms (Greenhouse/Lever/Workable are lowercase, but
 * SmartRecruiters company IDs are case-sensitive — lowercasing them breaks the
 * lookup). ATS-SPECIFIC canonicalization (casing, etc.) is NOT done here; it
 * belongs on the per-source adapter (`SourceAdapter.normalizeSlug`, Phase 6),
 * which calls `companySlug()` once it has produced the platform-canonical form.
 *
 * changes may need to be made here if slug formats change across ATS platforms
 * or if new ATS platforms are added that have different slug requirements.
 */
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

/** Apply the universal slug floor + trim, and brand. Throws on floor violation. */
export function companySlug(value: string): CompanySlug {
  const trimmed = value.trim();
  if (!SLUG_RE.test(trimmed)) {
    throw new Error(`Invalid CompanySlug: ${JSON.stringify(value)}`);
  }
  return trimmed as CompanySlug;
}

/** Trim + require a non-empty, whitespace-free id, and brand. Throws otherwise. */
export function jobId(value: string): JobId {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    throw new Error(`Invalid JobId: ${JSON.stringify(value)}`);
  }
  return trimmed as JobId;
}

/** Escape hatch for already-trusted values (e.g. read back from the DB). */
export const unsafeCompanySlug = (value: string): CompanySlug => value as CompanySlug;

/** Escape hatch for already-trusted values (e.g. read back from the DB). */
export const unsafeJobId = (value: string): JobId => value as JobId;

/**
 * Which ATS produced a job. A single-member union for now (Greenhouse is the
 * only adapter in Phase 1); it grows one member per adapter as they land in
 * Phase 6+. Kept a union, NOT `string`, so a typo is a compile error and the
 * Phase 2 `jobs.source` column / Phase 6 source registry stay exhaustive.
 */
export type SourceName = "greenhouse";

/**
 * Cross-source normalized job posting — the first real normalization contract.
 * In-memory only in Phase 1; persisted to Neon in Phase 2. Each field encodes a
 * decision about how heterogeneous ATS payloads collapse into one shape:
 *
 * - The shape is deliberately flat and source-agnostic. Source-specific quirks
 *   are resolved by each adapter's mapper, never leaked into this type.
 * - It is intentionally NOT generic over the raw payload and there is NO adapter
 *   interface here — that abstraction is extracted in Phase 6 from 2–3 concrete
 *   adapters, not designed up front.
 */
export interface NormalizedJob {
  /** Which ATS this came from. */
  source: SourceName;
  /**
   * The ATS-native posting id, branded. Numeric ids (Greenhouse `id`) are
   * stringified before `jobId()`; the brand is the canonical cross-ATS id type.
   */
  externalId: JobId;
  /** Posting title, as given by the ATS. */
  title: string;
  /**
   * Platform-canonical company slug. The per-ATS canonicalizer runs BEFORE
   * `companySlug()` (e.g. Greenhouse lowercases); `companySlug()` only enforces
   * the universal floor and must not transform casing (Phase 6 SmartRecruiters
   * is case-sensitive).
   */
  companySlug: CompanySlug;
  /**
   * Human-readable location strings exactly as the ATS gives them, e.g.
   * "Remote - United States" or "Hybrid - San Francisco, New York City". Empty
   * when the ATS supplies none. Multi-city strings are kept whole — no parsing
   * or splitting in Phase 1; structured location is a later concern.
   */
  locations: string[];
  /**
   * Best-effort remote flag. Many ATS (incl. Greenhouse) expose no structured
   * remote boolean, so adapters infer it from the location string. "Hybrid"
   * postings resolve to `false`. Treat as a heuristic, not ground truth.
   */
  remote: boolean;
  /**
   * Plain-text job description: HTML entities decoded, tags stripped, whitespace
   * collapsed. May be "" when the ATS supplies no body. The original markup is
   * always preserved in `raw`, so downstream consumers can re-derive richer text.
   */
  descriptionText: string;
  /** Public apply / listing URL. */
  applyUrl: string;
  /**
   * When the posting went live, or `null` if the ATS gives no parseable date.
   * Adapters pick the most "posted-like" field available (e.g. Greenhouse
   * `first_published`, falling back to `updated_at`).
   */
  postedAt: Date | null;
  /**
   * The untouched source object, for debugging and reprocessing. Typed `unknown`
   * (never `any`) so callers must narrow before reading source-specific fields.
   */
  raw: unknown;
}
