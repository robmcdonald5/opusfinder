-- The record of applied production data fixes (packages/db/fixes/; see its README). The fix runner inserts one
-- row per fix in the same transaction as the fix itself. Additive and touched by nothing else. Hand-guarded with
-- IF NOT EXISTS (drizzle-kit emits it bare; neon-http migrations are NOT transactional).
--
-- ROLLOUT: apply this (`pnpm db:migrate`) BEFORE running `pnpm --filter @opusfinder/db run data-fixer:setup`,
-- which grants the data_fixer role SELECT + INSERT on this table and aborts if it is missing.
CREATE TABLE IF NOT EXISTS "data_fixes" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sha256" text NOT NULL,
	"git_sha" text,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
