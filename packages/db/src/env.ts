import { fileURLToPath } from "node:url";

import { config } from "dotenv";

// Resolve packages/db/.env relative to THIS module, not the cwd. db scripts run
// with cwd=packages/db, but cross-package callers (e.g. the sources fetch script)
// run from their own directory — a cwd-relative load would silently miss the file
// and leave DATABASE_URL undefined. fileURLToPath (not a raw file:// string) keeps
// the Windows drive-letter path valid. quiet: silence dotenv@17's load banner.
config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

/**
 * Read + validate DATABASE_URL. The `config()` call above loads packages/db/.env
 * resolved relative to THIS module (see the note there), so any package's scripts
 * — not just db's — pick it up regardless of the cwd they run from.
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
