-- Drops both HNSW indexes. No query uses them: digest retrieval, embeddings:search and the eval pool are exact
-- scans, so the indexes only cost disk and an index update on every embedding write. Hand-guarded with IF EXISTS
-- (neon-http migrations are NOT transactional).
--
-- Plain DROP INDEX, not CONCURRENTLY: the test harness's migrator runs every migration inside one transaction,
-- where CONCURRENTLY is an error. A plain drop holds an ACCESS EXCLUSIVE lock on the table only for the catalog
-- change (well under a second), but it queues behind any running query on jobs, and every new one queues behind
-- it. ROLLOUT: apply outside an ingest tick (ticks start at :00 of even UTC hours). No code reads the indexes, so
-- it can go before or after the deploy.
DROP INDEX IF EXISTS "jobs_embedding_hnsw_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "user_profiles_embedding_hnsw_idx";
