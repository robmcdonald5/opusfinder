import { config } from "dotenv";

// quiet: silence dotenv@17's default load banner (filename + key count) on every run.
config({ quiet: true });

/**
 * Read + validate DATABASE_URL (loaded from packages/db/.env by dotenv, relative
 * to the cwd — run db scripts via `pnpm --filter @opusfinder/db <script>`).
 *
 * Centralizes the env guard so every script shares one friendly, actionable
 * error instead of an opaque driver failure. Throws (never returns a bad value).
 * Errors echo only the URL scheme (never the credentials, which live after
 * "://"), so the secret never lands in logs/CI output.
 */
export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy the repo-root .env.example to packages/db/.env and paste your Neon connection string.",
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    const scheme = url.match(/^[a-z][a-z0-9+.-]*(?=:\/\/)/i)?.[0];
    const found = scheme ? `found "${scheme}://"` : "no URL scheme found";
    throw new Error(
      `DATABASE_URL is not a Postgres connection string (${found}). Expected postgresql://...`,
    );
  }
  return url;
}
