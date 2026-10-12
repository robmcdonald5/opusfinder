-- The content signature a digest item's job had when the user was shown it. alreadyShownSignatures excludes it
-- next to the live jobs.content_signature, so an edit to a shown job can't let its same-text cross-posts back in.
-- Nullable, no backfill: older rows keep using the live signature alone. Hand-guarded with IF NOT EXISTS
-- (drizzle-kit emits ADD COLUMN bare; neon-http migrations are NOT transactional).
--
-- ROLLOUT: apply BEFORE the digest code that reads and writes it deploys.
ALTER TABLE "digest_items" ADD COLUMN IF NOT EXISTS "content_signature" text;
