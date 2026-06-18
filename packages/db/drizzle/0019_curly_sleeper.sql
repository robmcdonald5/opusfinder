-- Phase G3 — self-contained recommendation history (PHASE_G3_PLAN.md). Two concerns in one migration:
--
--  (G3a) Add nullable DISPLAY-SNAPSHOT columns to digest_items: the render fields (title, company slug,
--        apply url, locations, remote) copied off the LIVE jobs/companies row at persist, so a digest
--        renders — and the Phase-12 history view reads — without a live jobs join, and the record SURVIVES
--        the job's prune. All nullable (NULL on pre-G3 rows until backfill-digest-item-snapshot.ts; every
--        new row is populated at insert). NOT content_signature (decision 4) and NOT rank/score/reason
--        (already durable). NOT lifecycle_state (mutable — the email's G1b filter reads it live).
--
--  (G3d) Decouple two FKs so the prune can reclaim recommended-but-stale jobs WITHOUT erasing history:
--        - DROP digest_items.job_id → jobs FK (decision 5): the ON DELETE NO ACTION block would REJECT
--          pruning a closed+stale job that a digest_items row references; job_id stays a plain historical
--          int that may dangle post-prune (harmless — see schema.ts).
--        - digests.digest_run_id → digest_runs FK CASCADE → NO ACTION (decision 6): a digest_runs delete
--          (G3g's 90-day oplog retention) must never cascade run → digests → digest_items and erase the
--          recommendation history G3 makes durable. NO ACTION makes such a delete REFUSE while referenced.
--
-- neon-http migrations are NOT transactional, so every statement is hand-guarded to be independently
-- idempotent: ADD COLUMN → IF NOT EXISTS (0009/0013 discipline), DROP CONSTRAINT → IF EXISTS, and the
-- re-add → a DO/EXCEPTION duplicate_object block (Postgres has no ADD CONSTRAINT IF NOT EXISTS — 0007
-- discipline). DROP-then-readd with these guards is idempotent and converges on the NO ACTION action on
-- any re-run. No data backfill here — the snapshot backfill is a separate keyset script (owner-run).
ALTER TABLE "digest_items" ADD COLUMN IF NOT EXISTS "job_title" text;--> statement-breakpoint
ALTER TABLE "digest_items" ADD COLUMN IF NOT EXISTS "company_slug" text;--> statement-breakpoint
ALTER TABLE "digest_items" ADD COLUMN IF NOT EXISTS "apply_url" text;--> statement-breakpoint
ALTER TABLE "digest_items" ADD COLUMN IF NOT EXISTS "locations" jsonb;--> statement-breakpoint
ALTER TABLE "digest_items" ADD COLUMN IF NOT EXISTS "remote" boolean;--> statement-breakpoint
ALTER TABLE "digest_items" DROP CONSTRAINT IF EXISTS "digest_items_job_id_jobs_id_fk";--> statement-breakpoint
ALTER TABLE "digests" DROP CONSTRAINT IF EXISTS "digests_digest_run_id_digest_runs_id_fk";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "digests" ADD CONSTRAINT "digests_digest_run_id_digest_runs_id_fk" FOREIGN KEY ("digest_run_id") REFERENCES "public"."digest_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
