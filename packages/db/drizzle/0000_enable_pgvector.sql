-- Custom SQL migration file, put your code below! --

-- Enable pgvector for job/profile embeddings (Phase 4+). Idempotent.
CREATE EXTENSION IF NOT EXISTS vector;