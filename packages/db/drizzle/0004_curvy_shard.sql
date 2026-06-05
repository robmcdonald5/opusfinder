-- Phase 9: user_cv_files (append-only CV uploads + R2 keys) + user_profiles (one semantic profile
-- per user, with a Voyage embedding). neon-http migrations are NOT transactional, so every statement
-- is made independently idempotent by hand (drizzle-kit emits them bare): CREATE TABLE / CREATE
-- (UNIQUE) INDEX get IF NOT EXISTS, and the standalone FK ADD CONSTRAINT is wrapped in a
-- DO/EXCEPTION duplicate_object block (Postgres has no ADD CONSTRAINT IF NOT EXISTS) — same
-- discipline as 0001's FK, 0002's HNSW index, and 0003.
CREATE TABLE IF NOT EXISTS "user_cv_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"r2_original_key" text NOT NULL,
	"r2_text_key" text,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"status" text DEFAULT 'failed' NOT NULL,
	"error_sample" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"structured" jsonb NOT NULL,
	"preferences" jsonb,
	"embedding" vector(1024),
	"source_cv_file_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_source_cv_file_id_user_cv_files_id_fk" FOREIGN KEY ("source_cv_file_id") REFERENCES "public"."user_cv_files"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_profiles_user_id_uq" ON "user_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_profiles_embedding_hnsw_idx" ON "user_profiles" USING hnsw ("embedding" vector_cosine_ops);