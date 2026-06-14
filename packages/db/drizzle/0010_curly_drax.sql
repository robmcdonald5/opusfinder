-- Phase F2: jobs.consecutive_absences — the streak hysteresis behind lifecycle closing (sweepLifecycle /
-- Arm A). neon-http migrations are NOT transactional, so the statement is made independently idempotent:
-- drizzle-kit emits ADD COLUMN bare, so the IF NOT EXISTS guard is hand-added here (same discipline as 0003's
-- companies columns). NOT NULL + DEFAULT 0 back-fills existing rows atomically (every existing job starts at
-- streak 0). Pure smallint streak — the precedent companies.consecutive_probe_failures is integer, but a
-- streak bounded by the close threshold never needs integer range. See PHASE_F2_PLAN.md §3.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "consecutive_absences" smallint DEFAULT 0 NOT NULL;
