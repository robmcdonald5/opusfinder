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

/**
 * Digest delivery cadence — a TS union on a plain text column (no pgEnum, same idempotent-migration
 * rule as the db's `LifecycleState`/`RunStatus`/`CvFileStatus`). Lives here as the one shared contract
 * both the `user_preferences` repo (Phase 9.5) and the future settings form agree on.
 */
export type DigestCadence = "daily" | "weekly" | "monthly";

/**
 * How a digest run was started (Phase 10) — a manual CLI/trigger now vs the scheduled cadence cron that
 * lands in Phase 12 (with the deployed runtime). A TS union on a plain text column (no pgEnum, same
 * idempotent-migration rule as {@link DigestCadence}). Lives here so the db schema
 * (`digest_runs.trigger`) and the trigger CLI agree.
 */
export type DigestTrigger = "manual" | "cron";

/**
 * Per-item feedback a user gives on a digested job. Phase 10 RESERVES the `digest_items.feedback` column;
 * the Phase-12 UI writes it (saved/applied/dismissed/not-interested) and the rerank prompt later folds it
 * into cached context. A TS union on a plain text column (same idempotent-migration rule as above).
 */
export type DigestFeedback = "saved" | "applied" | "dismissed" | "not_interested";

/**
 * Indeed/LinkedIn-style location preference — a TS union on a plain text column (no pgEnum, same rule as
 * {@link DigestCadence}). Phase F3 stores it on `user_preferences.location_mode`; the digest retrieval
 * `geoMatches` filter branches on it. SUBSUMES the former `remote_ok` boolean (`remote_ok=true → 'any'`,
 * `false → 'onsite_only'`). NO `hybrid` member: {@link NormalizedJob.remote} is a best-effort boolean
 * ("Hybrid → false"), so a hybrid mode could not be honestly distinguished from `any`.
 * - `any` — remote roles pass; on-site roles pass when they match `locations` (or have no location data).
 * - `remote_only` — only remote roles pass (excludes all on-site).
 * - `onsite_only` — only on-site roles pass (excludes all remote), still subject to `locations`.
 */
export type LocationMode = "any" | "remote_only" | "onsite_only";

/**
 * The user-SETTABLE preferences (Phase 9.5) — the subset of the `user_preferences` row a settings
 * form / the `user:set-prefs` CLI writes, and the conservative defaults applied at user creation.
 * Deliberately NOT the full table row: system-managed delivery STATE (unsubscribe token, bounce
 * status, suppression, last-sent markers) is owned by the pipeline, never set through this contract.
 * The deterministic-filter fields (`locationMode`/`locations`/`recencyDays`/`exclusions`/`dealbreakers`)
 * feed the digest retrieval filter; the judgment-context fields (`yoeMin`/`yoeMax`/`minSalary`/`maxSalary`/
 * `dealbreakers`) feed the rerank + synthesis prompt via {@link composePromptPrefs} (Phase F3 — salary/YoE
 * are soft prompt signals, never hard retrieval filters).
 * `digestEnabled` gates delivery (Phase 10/11) while `digestCadence` drives the Phase-12 cadence cron.
 * Node-free shared (no db dep) so the CLI now and a future SvelteKit action later share one shape.
 */
export interface UserPreferences {
  /** Indeed/LinkedIn-style location filter (Phase F3) — a hard retrieval filter via geoMatches. SUBSUMES
   *  the former `remoteOk` boolean. */
  locationMode: LocationMode;
  /** Location strings the filter matches against; empty = no location constraint. */
  locations: string[];
  /** Salary floor in whole currency units; `null` = no floor. A soft prompt signal (never a hard filter). */
  minSalary: number | null;
  /** Salary ceiling in whole currency units; `null` = no cap (Phase F3). Independent of `minSalary`. */
  maxSalary: number | null;
  /** Target years-of-experience floor; `null` = no floor (Phase F3). A soft prompt signal (never a hard
   *  filter); the YoE band is the sole declared level signal. */
  yoeMin: number | null;
  /** Target years-of-experience ceiling; `null` = no ceiling (Phase F3). The YoE band is the SOLE declared
   *  level signal (the too-senior fix) — a categorical `targetLevel` was considered and dropped as
   *  redundant/ambiguous; YoE is the cleaner objective gate. */
  yoeMax: number | null;
  /** Max posting age (days) the digest considers. */
  recencyDays: number;
  /** Free-form, app-side post-query exclusion rules — the one sparse field; shape firms up in Phase 10. */
  exclusions: string[];
  /** Hard "never show" keywords (Phase F3): merged into the `exclusions` post-filter (a real drop) AND
   *  rendered as a prompt "avoid" line. */
  dealbreakers: string[];
  /** Delivery cadence. */
  digestCadence: DigestCadence;
  /** Master on/off for digest delivery. */
  digestEnabled: boolean;
}

/**
 * A cryptographically-random, URL-safe unsubscribe token for the RFC 8058 one-click List-Unsubscribe
 * header (Phase 12 — dormant through Phase 11's lean send, which ships no unsubscribe link/headers).
 * 32 bytes (256 bits) of Web Crypto randomness, lowercase-hex-encoded — node-free
 * (the `crypto` global is present in both Node and the Worker, same as the `crypto.randomUUID()`
 * already used in the ingest pipeline), so this stays out of `./userid`'s `node:crypto` and the main
 * entry remains Worker-safe. Generated ONCE at user creation and stored on
 * `user_preferences.unsubscribe_token`; NEVER derived from email (that would be guessable).
 */
export function generateUnsubscribeToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

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
 * composer (`composeProfileText`, below), and the dataset validator, so that notion has one
 * source of truth instead of a per-site copy of the trim/join logic. (The list of FIELDS each
 * composer feeds in necessarily stays at its call site.) Lives here, not in @opusfinder/embeddings,
 * so the dataset loader can reuse it without pulling the embeddings/db stack onto the load path.
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
 * most signal; skills and target roles are appended as compact, labeled context. The eval harness
 * calls this directly, so it embeds profiles exactly the way the Phase-9 ingest + Phase-10 digest
 * pipeline will. Empty iff every field is blank (per {@link composeEmbeddingText}).
 */
export function composeProfileText(profile: StructuredProfile): string {
  return composeEmbeddingText([
    profile.summary,
    profile.skills.length > 0 ? `Skills: ${profile.skills.join(", ")}` : "",
    profile.targetRoles.length > 0 ? `Target roles: ${profile.targetRoles.join(", ")}` : "",
  ]);
}

/**
 * The JUDGMENT-CONTEXT subset of {@link UserPreferences} that the rerank + synthesis prompt renders via
 * {@link composePromptPrefs} (Phase F3). Deliberately NOT part of {@link StructuredProfile} (which feeds the
 * embedding) — preferences are a prompt-boundary-only sibling block, never the match vector. `locationMode`
 * is excluded: it is a hard retrieval filter, and the rubric must not also SCORE location. A `Pick` of the
 * source contract (not a hand-copy) so the field types stay locked to {@link UserPreferences}.
 */
export type PromptPreferences = Pick<
  UserPreferences,
  "yoeMin" | "yoeMax" | "minSalary" | "maxSalary" | "dealbreakers"
>;

/**
 * Render the judgment-context preferences ({@link PromptPreferences}) into a compact labeled block for the
 * rerank + synthesis system prompt (Phase F3). Returns `""` when nothing is set, so an un-answered user
 * yields a byte-identical empty system prefix — their per-user prompt-cache prefix does not bust on deploy.
 * A small inline helper, deliberately NOT a {@link composeProfileText}-tier abstraction. NEVER fed into the
 * embedding (that is {@link composeProfileText}, which must stay prefs-free — see {@link StructuredProfile}).
 * Both nullable bounds independent: only-min, only-max, and both each render gracefully. `locationMode` is
 * intentionally absent — it is a hard filter, scored by neither prompt.
 */
export function composePromptPrefs(prefs?: PromptPreferences): string {
  if (!prefs) return "";
  const lines: string[] = [];
  const yoe = formatBoundedRange(prefs.yoeMin, prefs.yoeMax, "at least", "at most");
  if (yoe) lines.push(`Target years of experience: ${yoe}`);
  const salary = formatBoundedRange(prefs.minSalary, prefs.maxSalary, "from", "up to");
  if (salary) lines.push(`Salary preference: ${salary}`);
  if (prefs.dealbreakers.length > 0) lines.push(`Dealbreakers (avoid): ${prefs.dealbreakers.join(", ")}`);
  return lines.join("\n");
}

/** Render a min/max pair where either bound may be null (unbounded): both → "5-8"; only-min → "from 5" /
 *  "at least 5"; only-max → "up to 8" / "at most 8"; neither → "". The min/max words differ per field
 *  (salary reads "from … / up to …"; years read "at least … / at most …"). */
function formatBoundedRange(
  min: number | null,
  max: number | null,
  minWord: string,
  maxWord: string,
): string {
  if (min != null && max != null) return `${min}-${max}`;
  if (min != null) return `${minWord} ${min}`;
  if (max != null) return `${maxWord} ${max}`;
  return "";
}

/**
 * Minimum transcript length (chars, after trim) below which a CV extraction is treated as a FAILED
 * extraction — a shorter result means a corrupt, encrypted, or image-only PDF. The single definition
 * shared by the production pipeline (`ingestCv`) and the eval generator (`extract-profile`), so the
 * floor cannot silently drift between them (it previously lived as a copy in each).
 */
export const MIN_TRANSCRIPT_CHARS = 50;

/**
 * Non-fatal extraction warnings for a {@link StructuredProfile}: flags an empty summary / skills /
 * target-roles so a caller can surface a thin profile rather than store it blindly. The single
 * definition shared by `ingestCv` and the eval generator (both previously inlined the same checks).
 */
export function profileWarnings(profile: StructuredProfile): string[] {
  const w: string[] = [];
  if (profile.summary.trim().length === 0) w.push("empty summary");
  if (profile.skills.length === 0) w.push("no skills extracted");
  if (profile.targetRoles.length === 0) w.push("no target roles extracted");
  return w;
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
