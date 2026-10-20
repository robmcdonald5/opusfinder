-- Location places: the GeoNames gazetteer (`places`, filled by the owner-run `places:load`), what each company's
-- raw location strings mean (`location_strings`, filled by the location normalizer), and the user's home city +
-- radius on user_preferences. Additive only; user_preferences.locations stays until a later migration drops it.
-- Hand-guarded: IF NOT EXISTS on every CREATE / ADD COLUMN and a DO/EXCEPTION block around the FK (drizzle-kit
-- emits them bare; neon-http migrations are NOT transactional).
--
-- ROLLOUT: apply BEFORE the digest code that reads these columns deploys (drizzle selects every column of
-- user_preferences), then run places:load before setting any home_place_id (the FK needs the row).
CREATE TABLE IF NOT EXISTS "location_strings" (
	"company_id" integer NOT NULL,
	"raw" text NOT NULL,
	"place_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"remote_countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"unmatched" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" text,
	"reason" text,
	"prompt_version" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_strings_pk" PRIMARY KEY("company_id","raw")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "places" (
	"geonames_id" integer PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"name_norm" text NOT NULL,
	"ascii_norm" text NOT NULL,
	"alt_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"region_code" text,
	"region_name" text,
	"country_code" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"population" integer
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "home_place_id" integer;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "radius_miles" smallint DEFAULT 50 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "places_country_name_idx" ON "places" USING btree ("country_code","name_norm");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "places_country_ascii_idx" ON "places" USING btree ("country_code","ascii_norm");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "places_alt_names_idx" ON "places" USING gin ("alt_names");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_home_place_id_places_geonames_id_fk" FOREIGN KEY ("home_place_id") REFERENCES "public"."places"("geonames_id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
