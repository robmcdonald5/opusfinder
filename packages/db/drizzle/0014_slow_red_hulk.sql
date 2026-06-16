CREATE TABLE "health_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"check_id" text NOT NULL,
	"mode" text NOT NULL,
	"metric" real,
	"threshold" real,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "health_alerts_created_at_idx" ON "health_alerts" USING btree ("created_at");