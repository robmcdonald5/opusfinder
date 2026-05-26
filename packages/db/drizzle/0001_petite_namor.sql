CREATE TABLE IF NOT EXISTS "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"source" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"company_id" integer NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"description_text" text DEFAULT '' NOT NULL,
	"locations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"remote" boolean NOT NULL,
	"apply_url" text NOT NULL,
	"posted_at" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"embedding" vector(1024),
	"lifecycle_state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- FK guarded by a DO/EXCEPTION block: drizzle-kit emits a standalone
-- `ALTER TABLE ... ADD CONSTRAINT`, and Postgres has no `ADD CONSTRAINT IF NOT
-- EXISTS`. neon-http migrations are not transactional, so this keeps a partial
-- re-apply from wedging on a duplicate-constraint error.
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "companies_slug_source_uq" ON "companies" USING btree ("slug","source");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_source_external_id_uq" ON "jobs" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_company_id_idx" ON "jobs" USING btree ("company_id");
