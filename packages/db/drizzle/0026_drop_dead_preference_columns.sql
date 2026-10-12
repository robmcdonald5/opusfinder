-- Drops two columns nothing reads or writes: user_preferences.remote_ok (replaced by location_mode, which 0012
-- backfilled from it) and the never-populated user_profiles.preferences.
--
-- ROLLOUT: apply only AFTER Vercel runs code built without these columns. Drizzle's full-row selects name every
-- column the deployed schema.ts has, so the digest's preferences read fails while an older build is live.
-- Pre-check (expect 0): SELECT count(*) FROM user_profiles WHERE preferences IS NOT NULL;
ALTER TABLE "user_preferences" DROP COLUMN IF EXISTS "remote_ok";--> statement-breakpoint
ALTER TABLE "user_profiles" DROP COLUMN IF EXISTS "preferences";
