-- Phase F4: job-side structured enrichment columns on `jobs` (extracted from each row's own title +
-- description prose by a later Haiku pass — see repos/enrichment.ts). Path A: numeric YoE band
-- (yoe_min/yoe_max) + a salary range; NO categorical seniority_band (F3 dropped target_level). All six data
-- columns are NULLABLE-no-default (null = "absent in prose"); enriched_at is the SENTINEL (null = not yet
-- extracted). `IF NOT EXISTS` is hand-added (drizzle-kit emits bare ADD COLUMN) because neon-http migrations
-- are NOT transactional — a partial re-apply must be idempotent. Additive only: no FK, no index, no
-- vector/HNSW regeneration.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "yoe_min" smallint;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "yoe_max" smallint;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "salary_min" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "salary_max" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "salary_currency" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "salary_period" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "enriched_at" timestamp with time zone;
