-- Phase F8/F6: a partial btree over ONLY the un-embedded jobs rows, backing the recurring
-- `embedding IS NULL` scans (F6 embedding_backlog health count, jobsNeedingEmbedding, the F8
-- embed-backlog-drain's ORDER BY id LIMIT paging) so they index-scan instead of seq-scanning the
-- whole jobs table. Self-prunes to ~0 entries as rows embed. Additive to the existing jobs table.
-- Hand-edited to IF NOT EXISTS (drizzle-kit emits it bare; neon-http migrations aren't transactional —
-- same discipline as jobs_embedding_hnsw_idx / jobs_content_signature_idx / user_preferences_eligible_idx).
CREATE INDEX IF NOT EXISTS "jobs_unembedded_idx" ON "jobs" USING btree ("id") WHERE "jobs"."embedding" IS NULL;
