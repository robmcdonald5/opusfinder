-- Phase 9.5g: the two deferred app-table FKs — user_cv_files.user_id / user_profiles.user_id ->
-- user.id (ON DELETE CASCADE). Split out of 0005 because the throwaway Phase-9 placeholder rows would
-- have failed validation; applied now, AFTER the §7b wipe left only real-user rows. Each standalone FK
-- ADD CONSTRAINT is wrapped in a DO/EXCEPTION duplicate_object block (Postgres has no ADD CONSTRAINT IF
-- NOT EXISTS; neon-http migrations aren't transactional) — same discipline as 0001/0004/0005.
DO $$ BEGIN
 ALTER TABLE "user_cv_files" ADD CONSTRAINT "user_cv_files_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
