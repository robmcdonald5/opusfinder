-- Phase 11: per-send delivery state on digests (email_id / delivery_status / sent_at) — the send
-- step writes 'sent', the bounded delivery poll upgrades it, the failure catch writes 'failed'.
-- Additive only: no FK, no index (the only reader fetches by digests.id, the PK). Hand-edited to
-- ADD COLUMN IF NOT EXISTS (drizzle-kit emits it bare; neon-http migrations aren't transactional —
-- same discipline as the earlier migrations).
ALTER TABLE "digests" ADD COLUMN IF NOT EXISTS "email_id" text;--> statement-breakpoint
ALTER TABLE "digests" ADD COLUMN IF NOT EXISTS "delivery_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "digests" ADD COLUMN IF NOT EXISTS "sent_at" timestamp with time zone;
