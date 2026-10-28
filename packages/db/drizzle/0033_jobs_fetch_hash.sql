-- jobs.fetch_hash: a hash of the fields upsertJobs compares, so ingest can skip sending a posting that hasn't
-- changed since the last fetch. Nullable with no default, so the ADD is a metadata-only change (no table rewrite).
-- No backfill: NULL means "unknown, send it", and each posting's next write fills it in. IF NOT EXISTS is
-- hand-added (drizzle-kit emits ADD COLUMN bare) so a re-run is a no-op.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "fetch_hash" text;