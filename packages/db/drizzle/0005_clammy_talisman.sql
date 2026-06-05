-- Phase 9.5: real identity (Better Auth-owned `user`/`session`/`account`/`verification`) + the typed
-- per-user `user_preferences` table, plus the missing `user_cv_files.user_id` index. neon-http
-- migrations are NOT transactional, so every statement is made independently idempotent by hand
-- (drizzle-kit emits them bare): CREATE TABLE / CREATE [UNIQUE] INDEX get IF NOT EXISTS, and each
-- standalone FK ADD CONSTRAINT is wrapped in a DO/EXCEPTION duplicate_object block (Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS) — same discipline as 0001/0004.
--
-- NOTE: the FKs on the PRE-EXISTING user_profiles.user_id / user_cv_files.user_id -> user.id are
-- intentionally NOT here. Those tables hold throwaway Phase-9 rows whose placeholder user_id matches
-- no `user` row, so adding the FK now would fail validation. They land in a LATER migration, after the
-- §7b re-key (Phase 9.5g) leaves only real-user rows. The `user_cv_files.user_id` INDEX is safe to add
-- now (an index does not validate against a parent table).
CREATE TABLE IF NOT EXISTS "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"remote_ok" boolean DEFAULT true NOT NULL,
	"locations" text[] DEFAULT '{}'::text[] NOT NULL,
	"min_salary" integer,
	"recency_days" smallint DEFAULT 14 NOT NULL,
	"exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"digest_cadence" text DEFAULT 'weekly' NOT NULL,
	"digest_enabled" boolean DEFAULT true NOT NULL,
	"digest_suppressed_at" timestamp with time zone,
	"digest_bounce_status" text DEFAULT 'none' NOT NULL,
	"unsubscribe_token" text NOT NULL,
	"last_digest_sent_at" timestamp with time zone,
	"last_digest_email_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_token_uq" ON "session" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_email_uq" ON "user" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_preferences_user_id_uq" ON "user_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_preferences_unsubscribe_token_uq" ON "user_preferences" USING btree ("unsubscribe_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_cv_files_user_id_idx" ON "user_cv_files" USING btree ("user_id");
