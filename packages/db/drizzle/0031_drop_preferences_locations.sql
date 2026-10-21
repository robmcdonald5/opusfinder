-- Drop user_preferences.locations, the old free-text location filter that home_place_id + radius_miles
-- replaced in 0029. Nothing reads or writes it since then. Hand-guarded with IF EXISTS (neon-http
-- migrations are NOT transactional).
--
-- ROLLOUT IS REVERSED from 0029/0030: merge and let the deploy go out FIRST (the deployed code must no longer
-- select the column: drizzle selects every column), THEN apply this migration. Applied before that deploy,
-- the running build's selects of user_preferences would fail.
ALTER TABLE "user_preferences" DROP COLUMN IF EXISTS "locations";
