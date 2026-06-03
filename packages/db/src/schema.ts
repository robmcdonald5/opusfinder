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
  serial,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

import type { CompanySlug, JobId, SourceName } from "@opusfinder/shared";

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jobs_source_external_id_uq").on(t.source, t.externalId),
    index("jobs_company_id_idx").on(t.companyId),
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
