-- Phase 10: a partial index over the digest-eligible user_preferences rows, backing
-- listDigestRecipients' filter (digest_enabled AND digest_suppressed_at IS NULL). Additive to the
-- existing user_preferences table. Hand-edited to IF NOT EXISTS (drizzle-kit emits it bare; neon-http
-- migrations aren't transactional — same discipline as the earlier migrations).
CREATE INDEX IF NOT EXISTS "user_preferences_eligible_idx" ON "user_preferences" USING btree ("user_id") WHERE "user_preferences"."digest_enabled" AND "user_preferences"."digest_suppressed_at" IS NULL;
