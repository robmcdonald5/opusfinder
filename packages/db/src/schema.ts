/**
 * Drizzle schema for opusfinder. pgvector is enabled by the SQL migration
 * `drizzle/0000_enable_pgvector.sql`, not declared here.
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
  SourceName,
  StructuredProfile,
  UserId,
} from "@opusfinder/shared";

/**
 * Embedding vector width. Single source of truth for the jobs.embedding column AND the
 * `::vector(N)` casts in repos/embeddings.ts, so a model/dimension swap changes only this
 * constant (plus a migration). Must stay in sync with EMBED_DIMENSIONS in @opusfinder/embeddings.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/** A job's lifecycle: `closed` marks postings that have disappeared from their
 * ATS board. Kept a TS union on a plain `text` column (NOT a pgEnum): `CREATE TYPE`
 * has no `IF NOT EXISTS`, which would break the idempotent-migration rule. */
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
    // Free-form per-company metadata (name, careers URL, …).
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // `active` flips false after ~30 days of CONSECUTIVE failed probes (deactivateStale). The
    // staleness clock is COALESCE(last_live_at, created_at). Deactivation is gated on a non-zero
    // failure STREAK, so a never-failed row is never swept and SmartRecruiters' unassertable 200
    // (which never increments the streak) can't drift a healthy company. last_probed_at drives
    // reprobe ORDERING, not staleness.
    active: boolean("active").notNull().default(true),
    lastProbedAt: timestamp("last_probed_at", { withTimezone: true }),
    lastLiveAt: timestamp("last_live_at", { withTimezone: true }),
    consecutiveProbeFailures: integer("consecutive_probe_failures").notNull().default(0),
    // Last SUCCESSFUL, non-empty INGESTION of this board (board-health guard). Stamped by
    // markCompanyIngested after a clean upsertJobs with total>0 (repos/lifecycle.ts); a board that FAILS to
    // fetch or returns empty does NOT advance it. sweepStaleJobs only stale-closes a job whose company was
    // successfully fetched within the staleness TTL (`last_ingested_at >= now() - ttl`), so a board that is
    // DOWN for >TTL has its still-live jobs SPARED rather than false-closed. NULL until the first
    // successful ingest post-deploy ⇒ conservatively EXCLUDED from the timer until then.
    lastIngestedAt: timestamp("last_ingested_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("companies_slug_source_uq").on(t.slug, t.source),
    // Partial index over active rows, keyed to MATCH the reprobe query's ordering (last_probed_at
    // ASC NULLS FIRST, then id) so the planner range-scans it and LIMIT stops early instead of
    // sorting the whole active set.
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
 * `raw` (the untouched source payload) is DEPRECATED and NO LONGER WRITTEN — it was
 * write-only debug data that ballooned the DB. The column is kept NULLABLE for
 * rollback/backfill safety and emptied to NULL to reclaim space. To re-derive richer
 * text from a posting, re-ingest the board.
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
    // DEPRECATED — no longer written; kept nullable. See jobs doc above.
    raw: jsonb("raw"),
    // Voyage vectors. NULL until embedded, and reset to NULL when content changes
    // (see upsertJobs) so the backfill re-embeds it.
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    lifecycleState: text("lifecycle_state").$type<LifecycleState>().notNull().default("active"),
    // Consecutive trusted-fetch absences for this job — the streak hysteresis behind lifecycle closing
    // (sweepLifecycle). Incremented when an active job is absent from a complete board fetch, reset to 0
    // + revived to 'active' on reappearance, and lifecycle_state flips to 'closed' at
    // ABSENCE_CLOSE_THRESHOLD. Mirrors companies.consecutive_probe_failures in BEHAVIOR only but is a
    // PURE streak — NO time window and NO first_failed_at clock (a job's absence from a fully-fetched
    // board is a stronger, more local signal than a company probe streak). Do NOT add a time-window
    // second stage to "restore parity". Type note: the precedent column is `integer`; `smallint` is
    // deliberate here — a streak that stops at the close threshold never needs integer range.
    consecutiveAbsences: smallint("consecutive_absences").notNull().default(0),
    // The close clock. NON-NULL iff the row is CURRENTLY in a closed episode: stamped to now() at the
    // lifecycle close sites and CLEARED back to NULL on revive. DISTINCT from updated_at, which other
    // writers bump (a revive, a content change) and so cannot measure "closed for N days"; closed_at
    // moves ONLY on a close/revive transition. The prune (prune-stale-jobs.ts) reads it as the staleness
    // window's clock — a row is prunable only once it has been closed (closed_at < now() - WINDOW) AND is
    // referenced by no digest_items. NULL on every active row. Nullable, no default. No index at this
    // scale — the prune query filters lifecycle_state first; add a partial `(closed_at) WHERE
    // lifecycle_state='closed'` only if an EXPLAIN warrants it.
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // The last-fetch liveness clock. Stamped to now() by markJobsPresent (repos/lifecycle.ts), called per
    // board from runIngestion, for EVERY job a fetch actually returned — completeness-INDEPENDENTLY, so it
    // works identically for a fully-fetched board and a budget-capped partial fetch. The staleness closer
    // (sweepStaleJobs) closes an active job whose last_seen_at is older than STALE_SWEEP_TTL_DAYS *and*
    // whose board was successfully ingested within that window (the companies.last_ingested_at board-health
    // guard) — so a DOWN board's live jobs are SPARED, while a healthy board's un-restamped jobs close.
    //
    // A capped board re-fetches only its freshest ~N postings each tick and structurally never sees its
    // older tail; those tail jobs stop being stamped and close on the timer — an INTENDED FRESHNESS close
    // (past the retrieval recency window, already invisible to digests), NOT a proof-of-death close, and
    // REVERSIBLE: markJobsPresent revives any that re-enter the fetch window.
    //
    // NOT NULL DEFAULT now() so the ADD COLUMN backfills every existing row to a fresh stamp (no live job
    // lands instantly past the TTL). DELIBERATELY UN-indexed (keeps the markJobsPresent write HOT + the
    // table seq-scans at this size — same discipline as content_signature / closed_at); add a partial
    // `(last_seen_at) WHERE lifecycle_state='active'` only if an EXPLAIN on the sweepStaleJobs query warrants it.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    // md5 hex over an aggressively-NORMALIZED title + description_text (lower + whitespace-collapse +
    // btrim), written SQL-side in upsertJobs via signatureSql (repos/sql.ts) — the de-dup spine.
    // NON-unique BY DESIGN: cross-posts and reposts are MEANT to share a signature, so it is the
    // grouping key two read paths collide on (retrieval display-collapse + the shown-history anti-join),
    // NEVER a UNIQUE constraint (jobs_source_external_id_uq stays the upsert conflict target). NULL until
    // written/backfilled — the read paths treat NULL as "its own group", so un-backfilled rows are inert,
    // not wrong. DISTINCT from `embedding`/jobEmbeddingText: that folds these same two fields into a
    // SEMANTIC vector; this folds them into an EXACT-MATCH key — never merge the two.
    contentSignature: text("content_signature"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jobs_source_external_id_uq").on(t.source, t.externalId),
    index("jobs_company_id_idx").on(t.companyId),
    // Plain btree over the de-dup signature. Widen to a composite (content_signature, lifecycle_state,
    // id) ONLY if an EXPLAIN warrants it. drizzle-kit emits this bare; the migration hand-adds
    // IF NOT EXISTS (neon-http isn't transactional) — same discipline as the HNSW/FK guards below.
    index("jobs_content_signature_idx").on(t.contentSignature),
    // HNSW approximate-NN index over the Voyage embeddings. vector_cosine_ops because retrieval uses
    // the `<=>` cosine operator. drizzle-kit emits a bare `CREATE INDEX`; the migration is hand-edited
    // to add IF NOT EXISTS (neon-http migrations aren't transactional — same discipline as the FK below).
    index("jobs_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    // Partial btree over ONLY the un-embedded rows. Backs the recurring `embedding IS NULL` scans,
    // turning a full seq-scan into an index-only scan. Self-prunes to ~0 entries as rows embed, so it
    // stays tiny (same partial-index discipline as companies_active_last_probed_idx /
    // user_preferences_eligible_idx). The HNSW index above only covers NON-NULL vectors for the `<=>`
    // cosine path and cannot serve `IS NULL`. drizzle-kit emits this bare; the migration hand-adds
    // IF NOT EXISTS (neon-http isn't transactional) — same discipline as the guarded indexes above.
    index("jobs_unembedded_idx")
      .on(t.id)
      .where(sql`${t.embedding} IS NULL`),
    // FK with an explicit, stable constraint name. drizzle-kit emits a STANDALONE `ALTER TABLE ... ADD
    // CONSTRAINT`, and Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so the migration wraps it in a
    // DO/EXCEPTION block for idempotency (neon-http migrations aren't transactional). If you regenerate
    // the migration, re-apply that guard — a bare ADD CONSTRAINT would wedge a partial re-apply on a
    // duplicate-constraint error.
    foreignKey({
      columns: [t.companyId],
      foreignColumns: [companies.id],
      name: "jobs_company_id_companies_id_fk",
    }),
  ],
);

/** A pipeline run's lifecycle: a `running` row is written at the start and patched to a
 * terminal state at the end. TS union on a plain `text` column (no pgEnum — same call as
 * {@link LifecycleState}). */
export type RunStatus = "running" | "ok" | "error";

/** Which pipeline a run belongs to: `discovery` or `ingestion`. */
export type RunPipeline = "discovery" | "ingestion";

/** Open metric bag for a run, keyed by count name. Discovery and ingestion tally different
 * things (candidates/probed/inserted vs boards/changed/…), so it stays a free-form jsonb map
 * rather than fixed columns — same rationale as `companies.metadata` / `jobs.raw`. */
export type RunCounts = Record<string, number>;

/**
 * One row per pipeline run. `source` is NULL for a run that spans all sources (a discovery sweep)
 * and set for a per-source pass. `started_at` IS the row's creation time (startRun is the only
 * insert), so there is no separate created_at. `error_sample` holds a truncated, SECRET-FREE first
 * error (shape, never credentials — same discipline as the env guards). No FK: a run is not owned by
 * a company, so there is no DO/EXCEPTION constraint to guard.
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

/** A CV upload's status. TS union on a plain `text` column (no pgEnum — same call as {@link LifecycleState}).
 * Only two terminal values; `failed` doubles as the PROVISIONAL value inserted before transcription
 * succeeds, so a row left behind by a crash mid-ingest correctly reads as not-extracted. It flips to
 * `extracted` only once the text is stored. */
export type CvFileStatus = "extracted" | "failed";

/**
 * Hard-ish user preferences (remote / locations / salary). Feeds the deterministic filter, NOT the
 * embedding. Mirrors `EvalProfile.preferences`.
 */
export interface ProfilePreferences {
  remote?: boolean;
  locations?: string[];
  minSalary?: number;
}

/**
 * Append-only history of CV uploads + their R2 object references. One row per upload; never updated in
 * place except (a) the provisional `failed` → `extracted` status flip and (b) patching `r2_text_key`
 * once the transcript is cached. The original PDF and the cached transcript live in R2 — this table
 * holds only the keys, not the bytes.
 */
export const userCvFiles = pgTable(
  "user_cv_files",
  {
    id: serial("id").primaryKey(),
    // FK cascades on user delete. `.references(() => …)` uses a thunk so it can forward-reference
    // `user` (defined later in the file).
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
    // Backs getProfileTextKey's `WHERE user_id AND status='extracted'`. NOT unique — append-only
    // upload history, many rows per user.
    index("user_cv_files_user_id_idx").on(t.userId),
  ],
);

/**
 * The current semantic profile — ONE row per user (the `user_id` unique index is the upsert target;
 * latest CV wins). `structured` is the embeddable `{ summary, skills, targetRoles }`; `embedding` is
 * its Voyage vector — the QUERY side of retrieval, HNSW-cosine-indexed (mirrors `jobs.embedding` on
 * the document side, same EMBEDDING_DIMENSIONS). `source_cv_file_id` points at the upload backing it.
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
    // HNSW approximate-NN over the profile vectors (cosine `<=>`), mirroring jobs_embedding_hnsw_idx
    // (same neon-http IF NOT EXISTS gotcha).
    index("user_profiles_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    // FK to the backing upload, explicit stable name. Same DO/EXCEPTION idempotency guard as jobs' FK above.
    foreignKey({
      columns: [t.sourceCvFileId],
      foreignColumns: [userCvFiles.id],
      name: "user_profiles_source_cv_file_id_user_cv_files_id_fk",
    }),
  ],
);

// ─── Real identity (Better Auth-owned) + per-user preferences ───────────────────────────
//
// `user`/`session`/`account`/`verification` are OWNED by Better Auth (email+password now; magic-link /
// OAuth are future plugin enables), merged here into the unified schema in the repo's house style:
// snake_case columns; FKs as named `foreignKey({...}).onDelete(...)` (so the migration can guard each
// `ADD CONSTRAINT` in a DO/EXCEPTION block); uniqueness as a UNIQUE INDEX. Two DELIBERATE deviations
// from the generator: (1) `timestamptz` (the generator emits bare `timestamp`; the rest of this schema
// is timezone-aware and the adapter binds `Date` either way), and (2) a `defaultNow()` on every
// `updated_at` (the generator omits it on session/account — harmless insurance against a NOT NULL
// violation). These tables are server-only — the scrapers Worker NEVER imports `@opusfinder/auth` and
// never reads them.

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

/** Email-verification / password-reset tokens (Better Auth). Unused — no verification-email flow yet. */
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

/** Delivery-state bounce classification for the digest. TS union on plain text (no pgEnum — same call
 *  as {@link LifecycleState}). Pipeline-managed delivery STATE, distinct from the user-settable
 *  `UserPreferences` (@opusfinder/shared). */
export type DigestBounceStatus = "none" | "soft" | "hard";

/** Pipeline-managed delivery state for ONE digest's send (same no-pgEnum rule as
 *  {@link DigestBounceStatus}). 'none' = not attempted; 'sent' = accepted by Resend;
 *  'delivered'/'bounced'/'failed' = observed by the post-send poll. Deliberately NO 'complained'
 *  member — a spam complaint records 'delivered' (it WAS delivered) plus user-level suppression on
 *  {@link userPreferences}. */
export type DigestDeliveryStatus = "none" | "sent" | "delivered" | "bounced" | "failed";

/**
 * One preferences row per user (1:1, `user_id` UNIQUE — the upsert target), created with conservative
 * defaults at user creation. First-class columns for everything a digest `WHERE` clause touches (so the
 * planner can use them — JSONB keeps no statistics) plus the delivery/cadence/unsubscribe fields the
 * email step reads. The user-SETTABLE subset mirrors `UserPreferences` in @opusfinder/shared; the
 * delivery-STATE columns (`digest_suppressed_at`, `digest_bounce_status`, `last_digest_*`) are
 * pipeline-written, not form-set. `unsubscribe_token` is cryptographically random
 * (generateUnsubscribeToken), NEVER email-derived. Retires the never-populated
 * `user_profiles.preferences` jsonb.
 */
export const userPreferences = pgTable(
  "user_preferences",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id").$type<UserId>().notNull(),
    // --- user-settable filter prefs (deterministic filter) ---
    // @deprecated subsumed into `locationMode`; kept (soft-deprecated, unread). A follow-up migration
    // may DROP the column once verified.
    remoteOk: boolean("remote_ok").notNull().default(true),
    locations: text("locations")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    minSalary: integer("min_salary"),
    // Salary ceiling. Nullable-no-default (null = "no cap") — a 0 default would read as a real "stated
    // $0", not "absent". A soft prompt signal (never a hard filter).
    maxSalary: integer("max_salary"),
    recencyDays: smallint("recency_days").notNull().default(14),
    // The one sparse/free-form field — app-side post-query rules.
    exclusions: jsonb("exclusions").$type<string[]>().notNull().default([]),
    // Target years-of-experience band. NULLABLE-no-default (null = "no bound"; 0 is a real value). A
    // soft prompt signal (never a hard filter). smallint mirrors recency_days/consecutive_absences.
    yoeMin: smallint("yoe_min"),
    yoeMax: smallint("yoe_max"),
    // Hard "never show" keywords: merged into the `exclusions` post-filter at toFilterPrefs (a real drop
    // via the whole-word compileExclusions matcher) AND rendered as a prompt "avoid" line.
    dealbreakers: text("dealbreakers")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Indeed/LinkedIn-style location filter — a TS string-union on plain text (no pgEnum). SUBSUMES the
    // soft-deprecated `remote_ok` boolean above; geoMatches branches on it. Default 'any' = byte-identical
    // to remote_ok=true; the migration backfills existing rows from remote_ok (true→'any',
    // false→'onsite_only') so no current user's recall shifts.
    locationMode: text("location_mode").$type<LocationMode>().notNull().default("any"),
    // --- delivery prefs + state ---
    digestCadence: text("digest_cadence").$type<DigestCadence>().notNull().default("weekly"),
    digestEnabled: boolean("digest_enabled").notNull().default(true),
    digestSuppressedAt: timestamp("digest_suppressed_at", { withTimezone: true }),
    // The operator SEND PERMIT — the POSITIVE mirror of digest_suppressed_at above: NULL = NOT approved
    // = no send (fail-closed); a non-NULL timestamp = an operator granted the permit, and the stamp
    // itself is the "approved on date X" audit. A DB-native, per-user gate so granting is a single write
    // effective next tick (no redeploy), and an un-approved user is filtered out at recipient resolution
    // BEFORE any paid rerank/synthesis spend (listDigestRecipients + the digest.ts load-step re-check).
    // Nullable, NO default — exactly like digest_suppressed_at / last_ingested_at (a DEFAULT now() would
    // fail-OPEN by auto-approving every existing eval/seed row on apply). OPERATOR/PIPELINE STATE: written
    // ONLY by setDigestApproval (repos/preferences.ts), DELIBERATELY excluded from
    // toRow()/updatePreferences so the user:set-prefs CLI and any future settings form physically cannot
    // set it (same firewall as the other state columns below). Gates read it with a TRUTHY-NEGATION
    // (`!digestApprovedAt`), so a NULL or a not-yet-migrated/undefined field both fail closed.
    digestApprovedAt: timestamp("digest_approved_at", { withTimezone: true }),
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
    // Recipient query (listDigestRecipients): a partial index over only the digest-eligible rows, keyed
    // by user_id (the join + keyset column), so the planner enumerates eligible users without scanning
    // the whole table. Mirrors companies_active_last_probed_idx's partial style. The user-table half of
    // the gate (email_verified) is covered by the join to the user PK. The predicate also requires the
    // send permit (`digest_approved_at IS NOT NULL`) so the index stays in lockstep with the query's
    // eligible set (the permit is the most selective term).
    index("user_preferences_eligible_idx")
      .on(t.userId)
      .where(
        sql`${t.digestEnabled} AND ${t.digestSuppressedAt} IS NULL AND ${t.digestApprovedAt} IS NOT NULL`,
      ),
    foreignKey({
      columns: [t.userId],
      foreignColumns: [user.id],
      name: "user_preferences_user_id_user_id_fk",
    }).onDelete("cascade"),
  ],
);

// ─── Per-user digest pipeline (digest_runs → digests → digest_items) ──────────────────────
//
// Three tables: a run-level dispatch record mirroring {@link sourceRuns}, a per-user header, and the
// ranked items. The items table doubles as the already-shown dedup source (the (user_id, job_id)
// anti-join feeds the next run's excludeJobIds). Status/trigger/feedback are TS unions on plain `text`
// columns (no pgEnum — same idempotent-migration rule as everything above). `user_id`/`digest_id`/
// `digest_run_id` FKs cascade on parent delete; the `digest_items.job_id` FK deliberately does NOT (see
// its inline note). FKs are declared as named `foreignKey({...})` so the migration can guard each
// `ADD CONSTRAINT` in a DO/EXCEPTION block (neon-http migrations aren't transactional). The digest
// pipeline reads Neon via the neon-http `Db` (no transactions needed).

/**
 * One row per digest pipeline run — the orchestrator/dispatch record, mirroring {@link sourceRuns}.
 * `trigger` records how the run started (manual CLI trigger or the scheduled cadence cron). Because the
 * per-user fan-out is fire-and-forget on Inngest, the orchestrator finalizes this row to a terminal state
 * right after DISPATCH — it records how many recipients it dispatched (`counts`), not per-user
 * completion; per-user outcomes live on {@link digests}. `started_at` IS the row's creation time (no
 * separate created_at); `error_sample` is a truncated, SECRET-free first error (same discipline as
 * `source_runs.error_sample`). No company FK, like source_runs.
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
 * Per-user digest header — one row per user per run. `counts` is the per-user metric bag (candidates
 * retrieved, reranked, rerank cache tokens, synthesis ok/errored). A row existing = the per-user run
 * succeeded; failures stay in Inngest + {@link digestRuns}.error_sample. FKs → `user.id` and
 * `digest_runs.id`.
 *
 * UNIQUE (user_id, digest_run_id): one digest per user per run. The unique index is the GUARD for that
 * invariant; the persist step stays retry-idempotent (Inngest retries) by DELETING any prior digest for
 * this (user, run) first — the digest→items FK cascade clears its items — then inserting fresh. (A
 * header-only ON CONFLICT upsert is NOT enough: it would leave stale `digest_items` behind from a
 * partially-failed prior attempt.) The `user_id`-leading column order also serves the per-user history
 * lookup (no separate user_id index needed). Run-scoped lookups are a cold path here — left unindexed
 * for now.
 */
export const digests = pgTable(
  "digests",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id").$type<UserId>().notNull(),
    digestRunId: integer("digest_run_id").notNull(),
    itemCount: integer("item_count").notNull().default(0),
    counts: jsonb("counts").$type<RunCounts>().notNull().default({}),
    // --- per-send delivery state. Written ONLY by the send/poll steps: send sets email_id + 'sent' +
    // sent_at; the bounded poll upgrades delivery_status; the failure catch writes 'failed'. User-level
    // aggregates (last_digest_*, suppression) live on user_preferences — this is the per-send history.
    emailId: text("email_id"), // Resend email id; NULL until a send is accepted
    deliveryStatus: text("delivery_status").$type<DigestDeliveryStatus>().notNull().default("none"),
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
    // NO ACTION, NOT cascade. A cascading delete of a digest_runs row would erase the (user_id, job_id)
    // dedup + recommendation history that `alreadyShownJobIds` and the history view depend on. The
    // retention prune over `digest_runs` would turn that into a LIVE hazard — so this FK is NO ACTION: a
    // run-row delete REFUSES while any digest still references it (the prune's digest_runs gate carries a
    // matching `NOT EXISTS (… digests …)` clause, so it only ever prunes childless/aged-out runs).
    foreignKey({
      columns: [t.digestRunId],
      foreignColumns: [digestRuns.id],
      name: "digests_digest_run_id_digest_runs_id_fk",
    }).onDelete("no action"),
  ],
);

/**
 * The ranked items of a digest — AND the already-shown dedup source: the composite (user_id, job_id)
 * index backs the anti-join feeding the next run's `excludeJobIds`, with `user_id` denormalized so that
 * anti-join needs no join through {@link digests}. `rank`/`score` come from the (synchronous, Haiku)
 * rerank — synthesis writes `reason` and NEVER re-ranks. `feedback` is RESERVED for the UI — nullable,
 * unused now.
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
    // --- display snapshot: the render fields copied from the LIVE jobs/companies row at persist time
    // (insertDigestItems), so a digest renders — and the history view reads — WITHOUT a live jobs join,
    // and the record SURVIVES the job's prune (the prune may delete a closed+stale job EVEN when a
    // digest_items row references it). All nullable: NULL on pre-snapshot rows until the one-time keyset
    // backfill, then every new row is populated at insert. `getDigestEmailPayload` reads these FIRST,
    // COALESCE-falling-back to the live jobs/companies row during the backfill gap. DELIBERATELY NOT
    // `content_signature` (a durable signature snapshot would suppress a relisted role FOREVER, breaking
    // re-recommend-after-relist; the live INNER JOIN in `alreadyShownSignatures` is the self-scoping
    // cooldown) and NOT `rank`/`score`/`reason` (already durable columns above). `lifecycle_state` is
    // INTENTIONALLY not snapshotted: it is mutable, and the email's active-filter must read it LIVE, not
    // a frozen copy.
    jobTitle: text("job_title"),
    companySlug: text("company_slug"),
    applyUrl: text("apply_url"),
    locations: jsonb("locations").$type<string[]>(),
    remote: boolean("remote"),
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
    // job_id is a PLAIN historical reference — NO FK to jobs (the constraint was dropped). This lets the
    // prune hard-DELETE a closed+stale job EVEN when a digest_items row still references it; an ON DELETE
    // NO ACTION FK would REJECT that delete. A post-prune job_id may dangle — harmless by design:
    // `alreadyShownJobIds` matches it by id (a dangling id never collides with a live job's id) and
    // `alreadyShownSignatures` INNER-JOINs the LIVE jobs row, so a pruned row's signature self-drops from
    // the exclude set (the relist becomes re-recommendable; the retention window IS the cooldown). The
    // render/history display fields are preserved by the snapshot columns above, so dropping the FK loses
    // no user-visible data.
  ],
);

/**
 * Append-only health-incident log. The one health signal NOT re-derivable from the event tables:
 * `checkHealth` (health.ts) reads LIVE pipeline state, but nothing records WHEN a check fired over time.
 * The health-check alert fn / the dev panel's enforce path WRITES one row per enforce-firing; the dev
 * panel READS it for incident history. Shape-only — `check_id` (a `HealthCheckId`) + numeric
 * metric/threshold mirror {@link HealthCheck}; never job/user text (the no-secrets/PII invariant).
 * `check_id`/`mode` are plain `text` (not `.$type<HealthCheckId>()`) to avoid a schema→health→client
 * import cycle — the writer casts. Append-only: no updates, no deletes.
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
