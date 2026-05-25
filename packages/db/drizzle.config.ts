import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// quiet: silence dotenv@17's default load banner on every drizzle-kit run.
config({ quiet: true });

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  // Tolerant read (not the script-side getDatabaseUrl guard): `drizzle-kit
  // generate` runs offline and must not require a URL. Connection-requiring
  // commands (studio/push) surface drizzle-kit's own error if it's unset.
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  entities: { roles: { provider: "neon" } },
  strict: true,
  verbose: true,
});
