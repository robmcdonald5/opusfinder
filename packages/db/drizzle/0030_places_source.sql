-- Which GeoNames list a `places` row came from: 'main' (cities500, admin1, countries) or 'us-dump' (every
-- other US populated place, loaded by places:load to fill gaps the main list leaves). The location check
-- prefers a main-list city and takes a us-dump one only when it is the one place of that name in scope.
-- A constant default: existing rows read 'main' without a table rewrite (PostgreSQL 11+). Hand-guarded with
-- IF NOT EXISTS (neon-http migrations are NOT transactional).
--
-- ROLLOUT: apply BEFORE the code that reads `places.source` deploys (drizzle selects every column), then
-- run places:load.
ALTER TABLE "places" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'main' NOT NULL;
