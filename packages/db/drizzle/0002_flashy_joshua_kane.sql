-- HNSW index for cosine nearest-neighbour over Voyage embeddings (Phase 4).
-- Hand-edited to add IF NOT EXISTS: drizzle-kit emits a bare CREATE INDEX, and
-- neon-http migrations aren't transactional, so a re-run after a partial apply must
-- not wedge on a duplicate-index error (same discipline as the guarded FK in 0001).
CREATE INDEX IF NOT EXISTS "jobs_embedding_hnsw_idx" ON "jobs" USING hnsw ("embedding" vector_cosine_ops);