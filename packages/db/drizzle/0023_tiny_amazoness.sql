-- Tighten the digest-eligible partial index to also require the operator SEND PERMIT
-- (digest_approved_at IS NOT NULL), so it stays in lockstep with listDigestRecipients' WHERE now that the
-- query AND-s the permit (0022 added the column; this ships with the query/load-step gate). DROP-before-CREATE
-- because Postgres has no CREATE OR REPLACE INDEX — a bare CREATE on the existing name would no-op and silently
-- KEEP the old, looser predicate. Both statements hand-guarded with IF [NOT] EXISTS (drizzle-kit emits them
-- bare; neon-http migrations are NOT transactional — same discipline as 0008's original create + every guarded
-- index since). Table-qualified column form matches drizzle-kit's emit so the next `generate` shows zero drift.
DROP INDEX IF EXISTS "user_preferences_eligible_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_preferences_eligible_idx" ON "user_preferences" USING btree ("user_id") WHERE "user_preferences"."digest_enabled" AND "user_preferences"."digest_suppressed_at" IS NULL AND "user_preferences"."digest_approved_at" IS NOT NULL;