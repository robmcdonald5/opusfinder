-- Phase 10: the per-user digest pipeline tables — digest_runs (run/dispatch record, mirrors
-- source_runs), digests (per-user header), digest_items (ranked items + the already-shown dedup
-- source). neon-http migrations are NOT transactional, so every statement is made independently
-- idempotent by hand (drizzle-kit emits them bare): CREATE TABLE / CREATE INDEX get IF NOT EXISTS,
-- and each standalone FK ADD CONSTRAINT is wrapped in a DO/EXCEPTION duplicate_object block (Postgres
-- has no ADD CONSTRAINT IF NOT EXISTS) — same discipline as 0001/0004/0005. All three tables are
-- created before any FK is added, so the cross-table references (digest_items -> digests, digests ->
-- digest_runs) resolve regardless of statement order. NOTE: digest_items.job_id -> jobs.id is ON DELETE
-- NO ACTION (digest_items is append-only history + the dedup source); the digest/user/digest_run FKs
-- cascade. digests has a UNIQUE (user_id, digest_run_id) — one digest per user per run.
CREATE TABLE IF NOT EXISTS "digest_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"digest_id" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" integer NOT NULL,
	"rank" integer NOT NULL,
	"score" real NOT NULL,
	"reason" text NOT NULL,
	"feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "digest_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_sample" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "digests" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"digest_run_id" integer NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "digest_items" ADD CONSTRAINT "digest_items_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "digest_items" ADD CONSTRAINT "digest_items_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "digest_items" ADD CONSTRAINT "digest_items_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "digests" ADD CONSTRAINT "digests_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "digests" ADD CONSTRAINT "digests_digest_run_id_digest_runs_id_fk" FOREIGN KEY ("digest_run_id") REFERENCES "public"."digest_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "digest_items_user_id_job_id_idx" ON "digest_items" USING btree ("user_id","job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "digest_items_digest_id_idx" ON "digest_items" USING btree ("digest_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "digest_runs_started_idx" ON "digest_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "digests_user_id_digest_run_id_uq" ON "digests" USING btree ("user_id","digest_run_id");
