-- Phase F1: jobs.content_signature — the de-dup spine. md5 hex over a normalized title + description_text
-- (written SQL-side in upsertJobs via signatureSql), shared by the retrieval display-collapse and the
-- shown-history anti-join. neon-http migrations are NOT transactional, so each statement is made
-- independently idempotent: drizzle-kit emits ADD COLUMN / CREATE INDEX bare, so the IF NOT EXISTS guard
-- is hand-added here (same discipline as 0010's consecutive_absences and 0007's indexes). The column is
-- NULLABLE (NULL until written/backfilled — the read paths treat NULL as "its own group", so existing
-- rows are inert until the F1d backfill signs them) and NON-unique (cross-posts and reposts are MEANT to
-- collide on it). Plain btree over the bare column for v1; widen to a composite only if an EXPLAIN
-- warrants it. See PHASE_F1_PLAN.md §3.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "content_signature" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_content_signature_idx" ON "jobs" USING btree ("content_signature");
