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
