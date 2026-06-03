-- Phase 7: source_runs (the first run-tracked pipeline) + companies discovery/staleness
-- columns. neon-http migrations are NOT transactional, so every statement is made
-- independently idempotent. CREATE TABLE / ADD COLUMN / CREATE INDEX all support IF NOT
-- EXISTS; drizzle-kit emits them bare, so the guards are hand-added here (same discipline as
-- 0001's DO/EXCEPTION-guarded FK and 0002's hand-guarded HNSW index). NOT NULL + DEFAULT on
-- the new companies columns back-fills existing rows atomically.
CREATE TABLE IF NOT EXISTS "source_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"pipeline" text NOT NULL,
	"source" text,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_sample" text
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "last_probed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "last_live_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "consecutive_probe_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_runs_pipeline_started_idx" ON "source_runs" USING btree ("pipeline","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_active_last_probed_idx" ON "companies" USING btree ("last_probed_at" NULLS FIRST,"id") WHERE "companies"."active" = true;
