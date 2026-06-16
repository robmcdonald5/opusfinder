/**
 * Drizzle schema for opusfinder.
 *
 * Phase 2 introduces the first persistence layer: `companies` and `jobs`. The
 * `jobs.embedding` column is declared now but left nullable/unindexed — it gets
 * populated and HNSW-indexed in Phase 4. pgvector itself is enabled by the SQL
 * migration `drizzle/0000_enable_pgvector.sql`, not declared here.
 *
 * Conventions: snake_case column names (explicit), camelCase TS properties. The
 * brand types (`CompanySlug`, `JobId`, `SourceName`) come from `@opusfinder/shared`
 * and are attached with `.$type<>()` so the repo layer stays type-safe end to end.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import type {
  CompanySlug,
  DigestCadence,
  DigestFeedback,
  DigestTrigger,
  JobId,
  LocationMode,
  SalaryPeriod,
  SourceName,
  StructuredProfile,
  UserId,
} from "@opusfinder/shared";

/**
 * Embedding vector width (Voyage voyage-3-large default). The single source of truth for
 * the jobs.embedding column AND the `::vector(N)` casts in repos/embeddings.ts, so a
 * model/dimension swap changes only this constant (plus a migration) — no stray literal
 * can disagree with the column. Must stay in sync with the requested output_dimension in
 * @opusfinder/embeddings (EMBED_DIMENSIONS).
 */
export const EMBEDDING_DIMENSIONS = 1024;

/** A job's lifecycle. Phase 2 only ever writes `active`; `closed` lands when a
 * later phase marks postings that have disappeared from their ATS board. Kept a
 * TS union on a plain `text` column (NOT a pgEnum): `CREATE TYPE` has no
 * `IF NOT EXISTS`, which would break the idempotent-migration rule. */
export type LifecycleState = "active" | "closed";

/**
 * One row per (company, ATS) pair. The same company can in principle exist on
 * more than one ATS, so identity is `(slug, source)`, not slug alone. Slugs are
 * stored in their platform-canonical form (the adapter canonicalizes before
 * branding — Greenhouse lowercases; case-sensitive platforms do not).
 */
export const companies = pgTable(
  "companies",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").$type<CompanySlug>().notNull(),
    source: text("source").$type<SourceName>().notNull(),
    // Free-form per-company metadata (name, careers URL, …). Unused in Phase 2.
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // --- Phase 7 discovery / staleness tracking ---
    // `active` flips false after ~30 days of CONSECUTIVE failed probes (deactivateStale). The
    // staleness clock is COALESCE(last_live_at, created_at): a row decays from its last
    // confirmed-live probe, or — for a company seeded by ingestion that a discovery LIVE probe
    // has never refreshed (last_live_at NULL) — from when it was created. A row created longer ago
    // than the window can therefore be swept on its FIRST confirmed-absent probe; that is fine
    // (absent is a definitive 404, transients stay indeterminate, and deactivation is reversible).
    // last_probed_at (every probe) drives reprobe ORDERING, not staleness. Deactivation is gated on
    // a non-zero failure STREAK, so a never-failed row is never swept and SmartRecruiters'
    // unassertable 200 (which never increments the streak) can't drift a healthy company. A new row
    // starts active with a zero streak.
    active: boolean("active").notNull().default(true),
    lastProbedAt: timestamp("last_probed_at", { withTimezone: true }),
    lastLiveAt: timestamp("last_live_at", { withTimezone: true }),
    consecutiveProbeFailures: integer("consecutive_probe_failures").notNull().default(0),
  },
  (t) => [
    uniqueIndex("companies_slug_source_uq").on(t.slug, t.source),
    // Partial index over the reprobe candidates only (active rows), keyed to MATCH the reprobe
    // query's FULL ordering — last_probed_at ASC NULLS FIRST (never-probed rows first), then id
    // as the tiebreaker — so the planner range-scans it and LIMIT stops early instead of sorting
    // the whole active set (every row shares last_probed_at = NULL on the first sweep, one big
    // tie). Backs Phase 7's listCompaniesForReprobe.
    index("companies_active_last_probed_idx")
      .on(t.lastProbedAt.asc().nullsFirst(), t.id)
      .where(sql`${t.active} = true`),
  ],
);

/**
 * A normalized job posting — the persisted form of `NormalizedJob`. Identity is
 * `(source, external_id)` (the ATS-native posting id, unique within an ATS), so
 * re-ingesting the same board upserts in place rather than duplicating.
 *
 * `raw` keeps the untouched source payload for debugging/reprocessing; it is
 * refreshed on every real change but deliberately NOT part of change detection
 * (Greenhouse bumps an internal timestamp inside it on nearly every fetch).
 */
export const jobs = pgTable(
  "jobs",
  {
    id: serial("id").primaryKey(),
    externalId: text("external_id").$type<JobId>().notNull(),
    companyId: integer("company_id").notNull(),
    source: text("source").$type<SourceName>().notNull(),
    title: text("title").notNull(),
    descriptionText: text("description_text").notNull().default(""),
    locations: jsonb("locations").$type<string[]>().notNull().default([]),
    remote: boolean("remote").notNull(),
    applyUrl: text("apply_url").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    raw: jsonb("raw").notNull(),
    // Voyage voyage-3-large vectors (1024 dims), written by the Phase 4 embeddings
    // path. NULL until embedded, and reset to NULL when content changes (see
    // upsertJobs) so the backfill re-embeds it. HNSW-indexed below for retrieval.
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    lifecycleState: text("lifecycle_state").$type<LifecycleState>().notNull().default("active"),
    // Consecutive trusted-fetch absences for this job — the streak hysteresis behind lifecycle closing
    // (sweepLifecycle / Arm A, Phase F2). Incremented when an active job is absent from a complete board
    // fetch, reset to 0 + revived to 'active' on reappearance, and lifecycle_state flips to 'closed' at
    // ABSENCE_CLOSE_THRESHOLD. Mirrors companies.consecutive_probe_failures (schema.ts:87) in BEHAVIOR only
    // but is a PURE streak — NO 30-day time window and NO first_failed_at clock (a job's absence from a
    // fully-fetched board is a stronger, more local signal than a company probe streak; see
    // PHASE_F2_PLAN.md §2.3). Do NOT add a time-window second stage to "restore parity". Type note: the
    // precedent column is `integer`; `smallint` is deliberate here — a streak that stops at the close
    // threshold never needs integer range.
    consecutiveAbsences: smallint("consecutive_absences").notNull().default(0),
    // md5 hex over an aggressively-NORMALIZED title + description_text (lower + whitespace-collapse +
    // btrim), written SQL-side in upsertJobs via signatureSql (repos/sql.ts) — the de-dup spine
    // (Phase F1). NON-unique BY DESIGN: cross-posts and reposts are MEANT to share a signature, so it
    // is the grouping key two read paths collide on (retrieval display-collapse + the shown-history
    // anti-join), NEVER a UNIQUE constraint (the untouched jobs_source_external_id_uq stays the upsert
    // conflict target). NULL until written/backfilled — the read paths treat NULL as "its own group",
    // so un-backfilled rows are inert, not wrong. DISTINCT from `embedding`/jobEmbeddingText: that
    // folds these same two fields into a SEMANTIC vector; this folds them into an EXACT-MATCH key —
    // never merge the two. Item F4 (job-side enrichment) later appends structured fields to the
    // signature INPUT with no new migration (already nullable text). NOT in upsertJobs setWhere — it
    // is a pure function of the two fields setWhere already tests (see jobs.ts).
    contentSignature: text("content_signature"),
    // ─── Phase F4: job-side structured enrichment (extracted from this row's own title + description) ───
    // NULLABLE-no-default (null = "absent in prose"; a 0/'' default would read as a REAL extracted value, not
    // an absent one — cf. user_preferences.min_salary). yoe_min/yoe_max are the NUMERIC required-years band
    // (Path A — F3 dropped target_level, so the YoE band is the sole level signal on both the job and user
    // side); salary_period is a TS string-union on plain text (no pgEnum — same idempotent-migration rule as
    // LifecycleState). All six DATA columns are extracted ASYNCHRONOUSLY by a later Haiku pass
    // (repos/enrichment.ts) — NULL at upsert, exactly like `embedding`, and omitted from the INSERT VALUES.
    yoeMin: smallint("yoe_min"),
    yoeMax: smallint("yoe_max"),
    salaryMin: integer("salary_min"),
    salaryMax: integer("salary_max"),
    salaryCurrency: text("salary_currency"),
    salaryPeriod: text("salary_period").$type<SalaryPeriod>(),
    // The SENTINEL (Phase F4). NULL = not-yet-extracted — the `jobsNeedingEnrichment` WHERE key, NOT the data
    // columns (which are legitimately sometimes-all-NULL after a successful "found nothing" extraction, so
    // "all data NULL" can't distinguish not-yet-done from done-found-nothing). Set = extraction ran. Reset to
    // NULL by the upsertJobs CASE on title/description change (mirrors the embedding lifecycle). DELIBERATELY
    // NOT in upsertJobs setWhere — a derived field, like content_signature/embedding (see jobs.ts).
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jobs_source_external_id_uq").on(t.source, t.externalId),
    index("jobs_company_id_idx").on(t.companyId),
    // Plain btree over the de-dup signature (Phase F1). Backs the shown-history anti-join's
    // `content_signature <> ALL(...)` filter and the DISTINCT-signature lookup. Bare column for v1;
    // widen to a composite (content_signature, lifecycle_state, id) ONLY if an EXPLAIN on a real
    // grouping query warrants it (the small table seq-scans regardless today). drizzle-kit emits this
    // bare; the 0011 migration hand-adds IF NOT EXISTS (neon-http isn't transactional) — same
    // discipline as the HNSW/FK guards below.
    index("jobs_content_signature_idx").on(t.contentSignature),
    // HNSW approximate-NN index over the Voyage embeddings (Phase 4). vector_cosine_ops
    // because retrieval uses the `<=>` cosine operator. NOTE: drizzle-kit emits this as
    // a bare `CREATE INDEX` (no IF NOT EXISTS); the 0002 migration is hand-edited to add
    // the guard, since neon-http migrations aren't transactional (same discipline as the
    // FK below). CREATE INDEX CONCURRENTLY is deferred — the table is small now and it
    // can't run inside a single neon-http call.
    index("jobs_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    // FK with an explicit, stable constraint name. NOTE: drizzle-kit (0.31)
    // emits this as a STANDALONE `ALTER TABLE ... ADD CONSTRAINT`, NOT inline in
    // CREATE TABLE, and Postgres has no `ADD CONSTRAINT IF NOT EXISTS`. The 0001
    // migration therefore wraps it in a DO/EXCEPTION block for idempotency
    // (neon-http migrations aren't transactional). If you regenerate the
    // migration, re-apply that guard — a bare ADD CONSTRAINT would wedge a
    // partial re-apply on a duplicate-constraint error.
    foreignKey({
      columns: [t.companyId],
      foreignColumns: [companies.id],
      name: "jobs_company_id_companies_id_fk",
    }),
  ],
);

/** A pipeline run's lifecycle: a `running` row is written at the start and patched to a
 * terminal state at the end. TS union on a plain `text` column (NOT a pgEnum: `CREATE TYPE`
 * has no `IF NOT EXISTS`, which would break the idempotent-migration rule — same call as
 * {@link LifecycleState}). */
export type RunStatus = "running" | "ok" | "error";

/** Which pipeline a run belongs to. Phase 7 only writes `discovery`; `ingestion` lands in
 * Phase 8 when the ingestion Worker starts recording its runs here too. */
export type RunPipeline = "discovery" | "ingestion";

/** Open metric bag for a run, keyed by count name. Discovery and ingestion tally different
 * things (candidates/probed/inserted vs boards/changed/…), so it stays a free-form jsonb map
 * rather than fixed columns — same rationale as `companies.metadata` / `jobs.raw`. */
export type RunCounts = Record<string, number>;

/**
 * One row per pipeline run — the first run-tracked pipeline (Phase 7 discovery); Phase 8
 * reuses it for the ingestion + discovery Workers. `source` is NULL for a run that spans all
 * sources (a discovery sweep) and set for a per-source pass. `started_at` IS the row's creation
 * time (startRun is the only insert), so there is no separate created_at. `error_sample` holds a
 * truncated, SECRET-FREE first error (shape, never credentials — same discipline as the env
 * guards). No FK: a run is not owned by a company, so there is no DO/EXCEPTION constraint to guard.
 */
export const sourceRuns = pgTable(
  "source_runs",
  {
    id: serial("id").primaryKey(),
    pipeline: text("pipeline").$type<RunPipeline>().notNull(),
    source: text("source").$type<SourceName>(),
    status: text("status").$type<RunStatus>().notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    counts: jsonb("counts").$type<RunCounts>().notNull().default({}),
    errorSample: text("error_sample"),
  },
  (t) => [index("source_runs_pipeline_started_idx").on(t.pipeline, t.startedAt)],
);

/** A CV upload's status. TS union on a plain `text` column (NOT a pgEnum — same idempotent-migration
 * rule as {@link LifecycleState} / {@link RunStatus}). Only two terminal values; `failed` doubles as
 * the PROVISIONAL value inserted before transcription succeeds, so a row left behind by a crash
 * mid-ingest correctly reads as not-extracted. It flips to `extracted` only once the text is stored. */
export type CvFileStatus = "extracted" | "failed";

/**
 * Hard-ish user preferences (remote / locations / salary). Phase 9 leaves this NULL; the Phase-12
 * onboarding form fills it. Feeds the Phase-10 deterministic filter, NOT the embedding. Mirrors
 * `EvalProfile.preferences`; Phase 12 may unify the two in @opusfinder/shared when the form lands.
 */
export interface ProfilePreferences {
  remote?: boolean;
  locations?: string[];
  minSalary?: number;
}

/**
 * Append-only history of CV uploads + their R2 object references (Phase 9 CV ingestion). One row per
 * upload; never updated in place except (a) the provisional `failed` → `extracted` status flip and
 * (b) patching `r2_text_key` once the transcript is cached. The durable original PDF and the cached
 * transcribed text both live in R2 — this table holds only the keys, not the bytes.
 */
export const userCvFiles = pgTable(
  "user_cv_files",
  {
    id: serial("id").primaryKey(),
    // Phase 9 hand-minted a UUIDv5 from email; Phase 9.5 re-keyed this to a real `user.id`. The FK
    // (added in migration 0006, after the §7b wipe left only real-user rows) cascades on user delete.
    // `.references(() => …)` uses a thunk so it can forward-reference `user` (defined later in the file).
    userId: uuid("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // R2 object keys. The original is written before transcription; the text key is NULL until the
    // transcript is cached (and the status flips to 'extracted').
    r2OriginalKey: text("r2_original_key").notNull(),
    r2TextKey: text("r2_text_key"),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    status: text("status").$type<CvFileStatus>().notNull().default("failed"),
    // Truncated, SECRET- and PII-free first error (same discipline as source_runs.error_sample). A
    // CV's contact details ARE PII, so this must never echo file content.
    errorSample: text("error_sample"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Backs getProfileTextKey's `WHERE user_id AND status='extracted'` (Phase 9 had no index here).
    // NOT unique — append-only upload history, many rows per user.
    index("user_cv_files_user_id_idx").on(t.userId),
  ],
);

/**
 * The current semantic profile — ONE row per user (the `user_id` unique index is the upsert target;
 * latest CV wins). `structured` is the embeddable `{ summary, skills, targetRoles }`
 * (StructuredProfile); `embedding` is its Voyage vector — the QUERY side of retrieval, HNSW-cosine-
 * indexed for the Phase-10 nearest-jobs query (mirrors `jobs.embedding` on the document side, same
 * EMBEDDING_DIMENSIONS constant). `source_cv_file_id` points at the upload currently backing it.
 */
export const userProfiles = pgTable(
  "user_profiles",
  {
    id: serial("id").primaryKey(),
    // FK → user.id added in migration 0006 (cascade on user delete). Thunk forward-references `user`.
    userId: uuid("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    structured: jsonb("structured").$type<StructuredProfile>().notNull(),
    preferences: jsonb("preferences").$type<ProfilePreferences>(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    sourceCvFileId: integer("source_cv_file_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One profile per user — the onConflict target for upsertUserProfile.
    uniqueIndex("user_profiles_user_id_uq").on(t.userId),
    // HNSW approximate-NN over the profile vectors (cosine `<=>`), mirroring jobs_embedding_hnsw_idx.
    // The 0004 migration hand-adds IF NOT EXISTS (drizzle-kit emits a bare CREATE INDEX; neon-http
    // migrations aren't transactional).
    index("user_profiles_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    // FK to the backing upload, explicit stable name. drizzle-kit emits a standalone ADD CONSTRAINT
    // and Postgres has no ADD CONSTRAINT IF NOT EXISTS, so the 0004 migration wraps it in a
    // DO/EXCEPTION duplicate_object block (same discipline as jobs' FK in 0001).
    foreignKey({
      columns: [t.sourceCvFileId],
      foreignColumns: [userCvFiles.id],
      name: "user_profiles_source_cv_file_id_user_cv_files_id_fk",
    }),
  ],
);

// ─── Phase 9.5: real identity (Better Auth-owned) + per-user preferences ───────────────────────────
//
// `user`/`session`/`account`/`verification` are OWNED by Better Auth (email+password now; magic-link /
// OAuth are future plugin enables). They were emitted by `pnpm dlx @better-auth/cli generate` (with
// `advanced.database.generateId: "uuid"`, so ids are `uuid` not `text`) and merged here into the unified
// schema in the repo's house style: snake_case columns; FKs as named `foreignKey({...}).onDelete(...)`
// (so the migration can guard each `ADD CONSTRAINT` in a DO/EXCEPTION block); uniqueness as a UNIQUE
// INDEX (idempotent `CREATE UNIQUE INDEX IF NOT EXISTS`, not an ADD CONSTRAINT). Two DELIBERATE
// deviations from the generator: (1) `timestamptz` (the generator emits bare `timestamp`; the rest of
// this schema is timezone-aware and the adapter binds `Date` either way), and (2) a `defaultNow()` on
// every `updated_at` (the generator omits it on session/account, relying on the adapter to always send
// it — the default is harmless insurance against a NOT NULL violation). These tables are server-only —
// the scrapers Worker NEVER imports `@opusfinder/auth` and never reads them.

/** The identity/account row (Better Auth `user`). Kept lean — product data lives in the app tables that
 *  FK onto `user.id`. `image` is unused (no avatars yet); it comes free with the generated schema. */
export const user = pgTable(
  "user",
  {
    id: uuid("id")
      .$type<UserId>()
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("user_email_uq").on(t.email)],
);

/** A logged-in session (Better Auth). Unused while there is no UI, but part of the lib's owned set. */
export const session = pgTable(
  "session",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id").$type<UserId>().notNull(),
  },
  (t) => [
    uniqueIndex("session_token_uq").on(t.token),
    index("session_user_id_idx").on(t.userId),
    foreignKey({
      columns: [t.userId],
      foreignColumns: [user.id],
      name: "session_user_id_user_id_fk",
    }).onDelete("cascade"),
  ],
);

/** A credential/provider account (Better Auth). `providerId='credential'` for email+password; the
 *  `password` column holds the scrypt hash — it is a SECRET and must NEVER be logged or echoed. The
 *  OAuth token columns are unused now (future plugin enables). */
export const account = pgTable(
  "account",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id").$type<UserId>().notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("account_user_id_idx").on(t.userId),
    foreignKey({
      columns: [t.userId],
      foreignColumns: [user.id],
      name: "account_user_id_user_id_fk",
    }).onDelete("cascade"),
  ],
);

/** Email-verification / password-reset tokens (Better Auth). Unused until Phase 12 wires verification
 *  email to the real signup flow (Phase 11's lean send is digest delivery only). */
export const verification = pgTable(
  "verification",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/** Delivery-state bounce classification for the digest (Phase 11). A TS union on a plain text column
 *  (no pgEnum — same idempotent-migration rule as {@link LifecycleState}). Pipeline-managed delivery
 *  STATE, distinct from the user-settable `UserPreferences` (@opusfinder/shared). */
export type DigestBounceStatus = "none" | "soft" | "hard";

/** Pipeline-managed delivery state for ONE digest's send (Phase 11; same no-pgEnum rule as
 *  {@link DigestBounceStatus}). 'none' = not attempted (or allowlist-skipped); 'sent' = accepted by
 *  Resend; 'delivered'/'bounced'/'failed' = observed by the post-send poll. Deliberately NO
 *  'complained' member — a spam complaint records 'delivered' (it WAS delivered) plus user-level
 *  suppression on {@link userPreferences}. */
export type DigestDeliveryStatus = "none" | "sent" | "delivered" | "bounced" | "failed";

/**
 * One preferences row per user (1:1, `user_id` UNIQUE — the upsert target), created with conservative
 * defaults at user creation. First-class columns for everything a digest `WHERE` clause touches (so the
 * planner can use them — JSONB keeps no statistics) plus the delivery/cadence/unsubscribe fields the
 * Phase-11 email step reads. The user-SETTABLE subset mirrors `UserPreferences` in @opusfinder/shared;
 * the delivery-STATE columns (`digest_suppressed_at`, `digest_bounce_status`, `last_digest_*`) are
 * pipeline-written, not form-set. `unsubscribe_token` is cryptographically random (generateUnsubscribeToken),
 * NEVER email-derived. Retires the never-populated `user_profiles.preferences` jsonb.
 */
export const userPreferences = pgTable(
  "user_preferences",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id").$type<UserId>().notNull(),
    // --- user-settable filter prefs (Phase 10 deterministic filter) ---
    // @deprecated Phase F3 subsumes this into `locationMode`; kept (soft-deprecated, unread) during the
    // F3 build so each sub-block typechecks green. A follow-up migration may DROP the column once verified.
    remoteOk: boolean("remote_ok").notNull().default(true),
    locations: text("locations")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    minSalary: integer("min_salary"),
    // Salary ceiling (Phase F3). Nullable-no-default (null = "no cap"), the exact posture of min_salary
    // above — a 0 default would read as a real "stated $0", not "absent". Stored + soft-prompt in F3; a
    // hard retrieval filter in Phase F4 (once jobs gains salary columns).
    maxSalary: integer("max_salary"),
    recencyDays: smallint("recency_days").notNull().default(14),
    // The one sparse/free-form field — app-side post-query rules (shape firms up in Phase 10).
    exclusions: jsonb("exclusions").$type<string[]>().notNull().default([]),
    // --- F3 prefs (Phase F3) ---
    // Target years-of-experience band. NULLABLE-no-default (null = "no bound"; 0 is a real value, never a
    // default). Soft prompt signal in F3; Phase F4 adds the job-side jobs.yoe_min/yoe_max band, so the
    // deferred F4-FILTER can range-overlap this as a HARD filter (Path A — supersedes the earlier "YoE stays
    // soft, no job-side column" stance). smallint mirrors recency_days/consecutive_absences (ample for years).
    yoeMin: smallint("yoe_min"),
    yoeMax: smallint("yoe_max"),
    // Hard "never show" keywords (Phase F3): merged into the `exclusions` post-filter at toFilterPrefs (a
    // real drop via the whole-word compileExclusions matcher) AND rendered as a prompt "avoid" line.
    // Atomic-backfill template, mirrors `locations`/`exclusions` (which it also routes through). Free text
    // is CLI-set in F3 (low-risk); a Phase-12 form would sanitize it uniformly with `exclusions`.
    dealbreakers: text("dealbreakers")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Indeed/LinkedIn-style location filter (Phase F3) — a TS string-union on plain text (no pgEnum).
    // SUBSUMES the soft-deprecated `remote_ok` boolean above; geoMatches branches on it. Default 'any' =
    // byte-identical to remote_ok=true; migration 0012 backfills existing rows from remote_ok
    // (true→'any', false→'onsite_only') so no current user's recall shifts.
    locationMode: text("location_mode").$type<LocationMode>().notNull().default("any"),
    // --- delivery prefs + state (Phase 10/11) ---
    digestCadence: text("digest_cadence").$type<DigestCadence>().notNull().default("weekly"),
    digestEnabled: boolean("digest_enabled").notNull().default(true),
    digestSuppressedAt: timestamp("digest_suppressed_at", { withTimezone: true }),
    digestBounceStatus: text("digest_bounce_status")
      .$type<DigestBounceStatus>()
      .notNull()
      .default("none"),
    unsubscribeToken: text("unsubscribe_token").notNull(),
    lastDigestSentAt: timestamp("last_digest_sent_at", { withTimezone: true }),
    lastDigestEmailId: text("last_digest_email_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("user_preferences_user_id_uq").on(t.userId),
    uniqueIndex("user_preferences_unsubscribe_token_uq").on(t.unsubscribeToken),
    // Phase 10 recipient query (listDigestRecipients): a partial index over only the digest-eligible
    // rows, keyed by user_id (the join + keyset column), so the planner enumerates eligible users
    // without scanning the whole table. Mirrors companies_active_last_probed_idx's partial style. The
    // user-table half of the gate (email_verified) is covered by the join to the user PK.
    index("user_preferences_eligible_idx")
      .on(t.userId)
      .where(sql`${t.digestEnabled} AND ${t.digestSuppressedAt} IS NULL`),
    foreignKey({
      columns: [t.userId],
      foreignColumns: [user.id],
      name: "user_preferences_user_id_user_id_fk",
    }).onDelete("cascade"),
  ],
);

// ─── Phase 10: per-user digest pipeline (digest_runs → digests → digest_items) ──────────────────────
//
// Three tables (the spec's literal "digests and digest_items" plus digest_runs, additively): a run-level
// dispatch record mirroring {@link sourceRuns}, a per-user header, and the ranked items. The items table
// doubles as the already-shown dedup source (the (user_id, job_id) anti-join feeds the next run's
// excludeJobIds). Status/trigger/feedback are TS unions on plain `text` columns (NOT pgEnum — same
// idempotent-migration rule as everything above). `user_id`/`digest_id`/`digest_run_id` FKs cascade on
// parent delete; the `digest_items.job_id` FK deliberately does NOT (see its inline note). FKs are
// declared as named `foreignKey({...})` so migration 0007 can guard each `ADD CONSTRAINT` in a
// DO/EXCEPTION block (neon-http migrations aren't transactional). Email delivery is Phase 11; the digest
// pipeline reads Neon via the neon-http `Db` (no transactions needed).

/**
 * One row per digest pipeline run (Phase 10) — the orchestrator/dispatch record, mirroring
 * {@link sourceRuns}. `trigger` records how the run started (a manual CLI trigger now; the scheduled
 * cadence cron in Phase 12). Because the per-user fan-out is fire-and-forget on Inngest, the orchestrator
 * finalizes this row to a terminal state right after DISPATCH — it records how many recipients it
 * dispatched (`counts`), not per-user completion; per-user outcomes live on {@link digests}. `started_at`
 * IS the row's creation time (no separate created_at); `error_sample` is a truncated, SECRET-free first
 * error (same discipline as `source_runs.error_sample`). No company FK, like source_runs.
 */
export const digestRuns = pgTable(
  "digest_runs",
  {
    id: serial("id").primaryKey(),
    trigger: text("trigger").$type<DigestTrigger>().notNull(),
    status: text("status").$type<RunStatus>().notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    counts: jsonb("counts").$type<RunCounts>().notNull().default({}),
    errorSample: text("error_sample"),
  },
  (t) => [index("digest_runs_started_idx").on(t.startedAt)],
);

/**
 * Per-user digest header (Phase 10) — one row per user per run. `counts` is the per-user metric bag
 * (candidates retrieved, reranked, rerank cache read/creation tokens for the "cache hit rate >0" gate,
 * synthesis ok/errored) — the home for that gate's logging. A row existing = the per-user run succeeded;
 * failures stay in Inngest + {@link digestRuns}.error_sample. FKs → `user.id` and `digest_runs.id`.
 *
 * UNIQUE (user_id, digest_run_id): one digest per user per run. The unique index is the GUARD for that
 * invariant; the Phase-10f persist step stays retry-idempotent (Inngest retries) by DELETING any prior
 * digest for this (user, run) first — the digest→items FK cascade clears its items — then inserting
 * fresh. (A header-only ON CONFLICT upsert is NOT enough: it would leave stale `digest_items` behind
 * from a partially-failed prior attempt.) The `user_id`-leading column order also serves the per-user
 * history lookup (no separate user_id index needed). Run-scoped lookups (all digests for a run) are a
 * cold path here — left unindexed for now.
 */
export const digests = pgTable(
  "digests",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id").$type<UserId>().notNull(),
    digestRunId: integer("digest_run_id").notNull(),
    itemCount: integer("item_count").notNull().default(0),
    counts: jsonb("counts").$type<RunCounts>().notNull().default({}),
    // --- per-send delivery state (Phase 11, migration 0009). Written ONLY by the send/poll steps:
    // send sets email_id + 'sent' + sent_at; the bounded poll upgrades delivery_status; the failure
    // catch writes 'failed'. User-level aggregates (last_digest_*, suppression) live on
    // user_preferences — this is the per-send history the gate's bounce/failure logging needs.
    emailId: text("email_id"), // Resend email id; NULL until a send is accepted
    deliveryStatus: text("delivery_status")
      .$type<DigestDeliveryStatus>()
      .notNull()
      .default("none"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("digests_user_id_digest_run_id_uq").on(t.userId, t.digestRunId),
    foreignKey({
      columns: [t.userId],
      foreignColumns: [user.id],
      name: "digests_user_id_user_id_fk",
    }).onDelete("cascade"),
    // CASCADE HAZARD: deleting a digest_runs row cascades run → digests → digest_items, ERASING the
    // (user_id, job_id) dedup history `alreadyShownJobIds` depends on — already-shown jobs would
    // silently re-surface. No code deletes digest_runs today; any future retention/cleanup of run rows
    // must first denormalize the shown-history (or switch this FK to NO ACTION).
    foreignKey({
      columns: [t.digestRunId],
      foreignColumns: [digestRuns.id],
      name: "digests_digest_run_id_digest_runs_id_fk",
    }).onDelete("cascade"),
  ],
);

/**
 * The ranked items of a digest (Phase 10) — AND the already-shown dedup source: the composite
 * (user_id, job_id) index backs the anti-join feeding the next run's `excludeJobIds`, with `user_id`
 * denormalized so that anti-join needs no join through {@link digests}. `rank`/`score` come from the
 * (synchronous, Haiku) rerank — synthesis writes `reason` and NEVER re-ranks. `feedback` is RESERVED
 * for Phase 12 (the UI writes it; the rerank prompt folds it in later) — nullable, unused now.
 */
export const digestItems = pgTable(
  "digest_items",
  {
    id: serial("id").primaryKey(),
    digestId: integer("digest_id").notNull(),
    userId: uuid("user_id").$type<UserId>().notNull(),
    jobId: integer("job_id").notNull(),
    rank: integer("rank").notNull(),
    score: real("score").notNull(),
    reason: text("reason").notNull(),
    feedback: text("feedback").$type<DigestFeedback>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The already-shown anti-join (next run's excludeJobIds) AND the per-(user, job) history record.
    index("digest_items_user_id_job_id_idx").on(t.userId, t.jobId),
    index("digest_items_digest_id_idx").on(t.digestId),
    foreignKey({
      columns: [t.digestId],
      foreignColumns: [digests.id],
      name: "digest_items_digest_id_digests_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.userId],
      foreignColumns: [user.id],
      name: "digest_items_user_id_user_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.jobId],
      foreignColumns: [jobs.id],
      name: "digest_items_job_id_jobs_id_fk",
      // NO onDelete cascade (unlike the digest/user FKs above): digest_items is an append-only
      // history + the already-shown dedup source, so a job row must NOT silently erase the dedup
      // record (matches jobs.company_id's plain FK convention). Jobs are soft-closed, never hard-
      // deleted; if a hard delete is ever added it must explicitly handle dependent digest_items.
    }),
  ],
);

/**
 * Append-only health-incident log (Phase-12 12a-4; the F6-reserved migration 0014). The one health signal
 * NOT re-derivable from the event tables: `checkHealth` (health.ts) reads LIVE pipeline state, but nothing
 * records WHEN a check fired over time. A future health-check alert fn / the dev panel's enforce path (12b)
 * WRITES one row per enforce-firing; the Phase-12 dev panel READS it for incident history. Created here so
 * 12b is purely additive (no later migration). Shape-only — `check_id` (a `HealthCheckId`) + numeric
 * metric/threshold mirror {@link HealthCheck}; never job/user text (the F6 no-secrets/PII invariant).
 * `check_id`/`mode` are plain `text` (not `.$type<HealthCheckId>()`) to avoid a schema→health→client import
 * cycle — the writer casts. Append-only: no updates, no deletes.
 */
export const healthAlerts = pgTable(
  "health_alerts",
  {
    id: serial("id").primaryKey(),
    checkId: text("check_id").notNull(),
    mode: text("mode").notNull(),
    metric: real("metric"),
    threshold: real("threshold"),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("health_alerts_created_at_idx").on(t.createdAt)],
);
