-- digest_delivery: whether an account's finished digest is emailed ('email') or only stored ('logs').
-- The default is 'logs', so a new account is never emailed until someone sets 'email'. Accounts that hold
-- the send permit today keep being emailed: they get 'email' here, so no account's behaviour changes by
-- itself. Hand-guarded (drizzle-kit emits the ADD bare; neon-http migrations are NOT transactional): the
-- add and its backfill run as ONE statement, and only when the column is missing, so a re-run can't flip
-- an account that was set back to 'logs' afterwards.
--
-- ROLLOUT: apply before any code that reads the column is deployed (the digest Worker, and apps/web on merge).
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'user_preferences' AND column_name = 'digest_delivery'
	) THEN
		ALTER TABLE "user_preferences" ADD COLUMN "digest_delivery" text DEFAULT 'logs' NOT NULL;
		UPDATE "user_preferences" SET "digest_delivery" = 'email' WHERE "digest_approved_at" IS NOT NULL;
	END IF;
END $$;--> statement-breakpoint
-- digest_instance_id: the Workflow instance the daily tick last started for the user, read by the next tick
-- to skip a user whose run hasn't finished. Nullable with no default (a metadata-only change).
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "digest_instance_id" text;
