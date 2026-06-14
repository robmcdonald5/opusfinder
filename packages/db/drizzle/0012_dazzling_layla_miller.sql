-- Phase F3: user preferences — salary ceiling, YoE band, dealbreakers, and the Indeed/LinkedIn-style
-- location_mode that SUBSUMES the (now soft-deprecated) remote_ok boolean. (A categorical target_level was
-- considered and dropped — the numeric YoE band is the cleaner, sufficient declared-level gate.)
-- neon-http migrations are NOT transactional, so each statement is independently idempotent: drizzle-kit
-- emits ADD COLUMN bare, so the IF NOT EXISTS guard is hand-added here (same discipline as 0011's
-- content_signature / 0010's consecutive_absences). The NOT-NULL columns use the atomic
-- `type DEFAULT x NOT NULL` template (the 0005 precedent) so existing rows backfill in one statement.
-- max_salary/yoe_min/yoe_max are NULLABLE-no-default (null = "not answered"; a 0 default would read as a
-- real value). remote_ok is KEPT (soft-deprecated, unread after F3) — a follow-up migration may DROP it
-- once verified. See PHASE_F3_PLAN.md §3.
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "max_salary" integer;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "yoe_min" smallint;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "yoe_max" smallint;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "dealbreakers" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "location_mode" text DEFAULT 'any' NOT NULL;--> statement-breakpoint
-- Backfill location_mode from the boolean BEFORE any reader switches to it (Block 3), so no existing
-- user's recall shifts: remote_ok=true → 'any' (the new column's default, already correct), false →
-- 'onsite_only' (the old remote_ok=false behavior). Only the remote_ok=false rows need flipping, so the
-- UPDATE is scoped to them — it never touches a row already at the 'any' default, keeping it idempotent
-- and unable to clobber a value set after the column landed.
UPDATE "user_preferences" SET "location_mode" = 'onsite_only' WHERE NOT "remote_ok";
