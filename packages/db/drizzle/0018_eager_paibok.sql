-- Phase G2a: the `closed_at` close clock on jobs — the staleness clock the G2 prune
-- (prune-stale-jobs.ts) keys on. NON-NULL iff the row is CURRENTLY closed: stamped at the lifecycle
-- close sites and cleared on revive (lifecycle.ts). DISTINCT from updated_at (which other writers bump),
-- so it alone can measure "closed for N days". Nullable, no default. neon-http migrations are NOT
-- transactional, so the bare `ADD COLUMN` drizzle-kit emits is hand-guarded with IF NOT EXISTS (same
-- discipline as 0011/0012/0017). See PHASE_G2_PLAN.md §2.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;--> statement-breakpoint
-- One-time backfill for rows already closed before this column landed (the G1→G2 gap — G1 enforce went
-- live 2026-06-18, so a real, growing population of closed rows exists with no closed_at). A freshly-closed
-- row's updated_at IS its close time until something revives it (and a revive would have flipped it back to
-- active), so updated_at is an accurate approximation of closed_at for the still-closed set. Scoped to the
-- still-closed, still-NULL rows so it is idempotent and can never clobber a closed_at the new code already
-- stamped. Rows left NULL after this (every active row, plus any closed in the migrate→deploy gap by the
-- pre-G2a code) are CONSERVATIVELY ineligible for pruning — the prune requires closed_at < now() - window,
-- which NULL never satisfies. Same in-migration backfill pattern as 0012's location_mode. The count is
-- small (~thousands) so a single UPDATE is fine — no id-keyset chunking needed at this table size.
UPDATE "jobs" SET "closed_at" = "updated_at" WHERE "lifecycle_state" = 'closed' AND "closed_at" IS NULL;
