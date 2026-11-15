-- embedding_model: the id of the model that produced each stored vector, on jobs and user_profiles. Two models
-- embed into different spaces, so retrieval compares a profile vector only with job vectors carrying the same tag.
-- Nullable with no default, so each ADD is a metadata-only change (no table rewrite). Hand-guarded (drizzle-kit
-- emits these bare; neon-http migrations are NOT transactional): IF NOT EXISTS on the columns, a WHERE that makes
-- the backfill a no-op on re-run, and DO/EXCEPTION blocks around the constraints.
--
-- ROLLOUT: apply between ingest ticks, then deploy at once. Code from before this migration clears or writes a
-- vector without its tag, which the CHECK below rejects, and code from after it writes a column that has to exist.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "embedding_model" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "embedding_model" text;--> statement-breakpoint
-- Backfill, before the CHECKs. Every stored job vector is voyage-4-large: the corpus was flushed and re-embedded
-- when the model moved off voyage-3-large (2026-06-19), and a read of production on 2026-11-15 found all 42,702
-- job vectors in one space (cosine similarity to the centroid of the post-swap vectors 0.15 to 0.76, median 0.63;
-- the 14 lowest are near-empty postings whose nearest post-swap neighbour is 0.30 to 0.53 away). One UPDATE of
-- about 43k rows; the vectors are TOASTed and not rewritten.
UPDATE "jobs" SET "embedding_model" = 'voyage-4-large' WHERE "embedding" IS NOT NULL AND "embedding_model" IS NULL;--> statement-breakpoint
-- A profile vector has no refill, so one last written before the swap is still the old model's. The same read
-- found two such (similarity to the centroid about 0, nearest job 0.91+ away, against 0.35 for the third). The
-- old model's id can't be proven per row, so those vectors are cleared, not tagged on a guess; the profile's
-- structured fields stay, and `profiles:restructure` re-embeds it from the cached transcript.
UPDATE "user_profiles" SET "embedding" = NULL WHERE "embedding" IS NOT NULL AND "embedding_model" IS NULL AND "updated_at" < '2026-06-19T00:00:00Z';--> statement-breakpoint
UPDATE "user_profiles" SET "embedding_model" = 'voyage-4-large' WHERE "embedding" IS NOT NULL AND "embedding_model" IS NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "jobs" ADD CONSTRAINT "jobs_embedding_model_paired" CHECK (("jobs"."embedding" IS NULL) = ("jobs"."embedding_model" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_embedding_model_paired" CHECK (("user_profiles"."embedding" IS NULL) = ("user_profiles"."embedding_model" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
