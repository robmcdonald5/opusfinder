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
 * A stable per-user identifier (a UUID string). Phase 9 hand-mints it deterministically from
 * the user's email via `mintUserId` (in the dedicated `@opusfinder/shared/userid` entry point —
 * it pulls `node:crypto`, kept off this module so the Worker bundle stays node-free, same
 * discipline as `./env`); a real users table / auth supplies it later. Branded so a raw string
 * can't be passed where a user id is expected.
 */
export type UserId = Brand<string, "UserId">;

/** Escape hatch for already-trusted values (e.g. read back from the DB). */
export const unsafeUserId = (value: string): UserId => value as UserId;

/**
 * Which ATS produced a job. Grows one member per adapter as they land (Phase 6
 * adds Lever, Ashby, Workable, SmartRecruiters; Phase 6.5 Wave A adds Recruitee,
 * Pinpoint, Gem, Trakstar — all zero-hydrate public boards). Kept a union, NOT
 * `string`, so a typo is a compile error and the `jobs.source` column / source
 * registry (`Record<SourceName, SourceAdapter>`) stay exhaustive — a missing
 * adapter is a compile error.
 */
export type SourceName =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workable"
  | "smartrecruiters"
  | "pinpoint"
  | "gem"
  | "recruitee"
  | "trakstar";

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

/**
 * Narrow an `unknown` to a plain object (record). Shared by the ATS adapters and the
 * embeddings provider when validating untrusted JSON response shapes, so the guard has
 * one definition instead of a copy per parser.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Compose the text sent to an embedding model from its parts: drop blank (whitespace-only)
 * parts and join the rest with a blank line. This is the SINGLE definition of how embedding
 * input is composed and of what "no embeddable content" means — the result is `""` iff every
 * part is blank. Shared by the job composer (`jobEmbeddingText` in @opusfinder/db), the profile
 * composer (`profileEmbeddingText` in eval), and the dataset validator, so that notion has one
 * source of truth instead of a per-site copy of the trim/join logic. (The list of FIELDS each
 * composer feeds in necessarily stays at its call site.) Lives here, not in @opusfinder/embeddings,
 * so the dataset loader can reuse it without pulling the embeddings/db stack onto the load path.
 *
 * Used by the job composer (`jobEmbeddingText` in @opusfinder/db) and the profile composer
 * (`composeProfileText`, below — the eval harness's `profileEmbeddingText` delegates to it).
 */
export function composeEmbeddingText(parts: string[]): string {
  return parts.filter((s) => s.trim().length > 0).join("\n\n");
}

/**
 * The semantic CV profile — the embeddable, PII-free representation produced by Phase 9 CV
 * ingestion and stored in `user_profiles.structured`. Deliberately the `{ summary, skills,
 * targetRoles }` subset that feeds the match vector: NO `id` (that is an eval-only handle on
 * `EvalProfile`) and NO contact info / addresses (the extraction prompts drop them — they add no
 * job-alignment signal and dilute the vector). `preferences` is intentionally NOT here: it comes
 * from the Phase-12 onboarding form, not the CV, and feeds the deterministic filter (Phase 10),
 * not the embedding.
 */
export interface StructuredProfile {
  /** Free-text career summary — the bulk of the embedded "query" text. */
  summary: string;
  /** Skills / technologies. */
  skills: string[];
  /** Roles the person is targeting (e.g. "Senior Backend Engineer"). */
  targetRoles: string[];
}

/**
 * Compose the text embedded for a profile — the "query" side of retrieval — from a
 * {@link StructuredProfile}. The SINGLE source of truth for what goes in the profile vector
 * (mirrors `jobEmbeddingText`, the "document" side in @opusfinder/db): the summary carries the
 * most signal; skills and target roles are appended as compact, labeled context. The eval
 * harness's `profileEmbeddingText` delegates here, so the harness embeds profiles exactly the way
 * the Phase-9 ingest + Phase-10 digest pipeline will. Empty iff every field is blank (per
 * {@link composeEmbeddingText}).
 */
export function composeProfileText(profile: StructuredProfile): string {
  return composeEmbeddingText([
    profile.summary,
    profile.skills.length > 0 ? `Skills: ${profile.skills.join(", ")}` : "",
    profile.targetRoles.length > 0 ? `Target roles: ${profile.targetRoles.join(", ")}` : "",
  ]);
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// A phone-like run: optional + and (, then digits/separators. Redacted ONLY when it contains >=10
// digits, so it never eats a year range like "2015-2019" (8 digits) or a metric like "p99".
const PHONE_CANDIDATE_RE = /\+?\(?\d[\d\s().-]{8,}\d/g;

function scrubText(text: string): string {
  const noEmail = text.replace(EMAIL_RE, "[redacted]");
  const noPhone = noEmail.replace(PHONE_CANDIDATE_RE, (m) =>
    (m.match(/\d/g)?.length ?? 0) >= 10 ? "[redacted]" : m,
  );
  return noPhone.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Defense-in-depth PII scrub for a {@link StructuredProfile}. The CV extraction prompts already
 * instruct the model to omit PII, but LLM instructions are not a hard guarantee on untrusted CV text
 * and the profile is persisted + vectorized — so the Phase-9 pipeline ALWAYS runs this before storing
 * and embedding. It lives here (node-free shared) so the Worker-portable pipeline (`@opusfinder/profiles`)
 * can call it structurally rather than relying on a seam contract. It redacts the machine-detectable
 * PII (email addresses + phone runs of >=10 digits); names are not regex-detectable and remain a
 * prompt-only concern.
 */
export function scrubProfilePii(profile: StructuredProfile): StructuredProfile {
  return {
    summary: scrubText(profile.summary),
    skills: profile.skills.map(scrubText).filter((s) => s.length > 0),
    targetRoles: profile.targetRoles.map(scrubText).filter((s) => s.length > 0),
  };
}
