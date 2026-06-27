import { loadPackageEnv, requireEnv } from "@opusfinder/shared/env";

// Load packages/db/.env relative to THIS module (see loadPackageEnv), so any package's
// scripts — not just db's — pick up DATABASE_URL regardless of the cwd they run from.
loadPackageEnv(import.meta.url);

/**
 * Read + validate DATABASE_URL. The format check echoes only the URL scheme (never the
 * credentials after "://"), so the secret never lands in logs/CI output.
 */
export const getDatabaseUrl = requireEnv({
  name: "DATABASE_URL",
  notSetMessage:
    "DATABASE_URL is not set. Copy the repo-root .env.example to packages/db/.env and paste your Neon connection string.",
  validate: (url) => {
    if (!/^postgres(ql)?:\/\//i.test(url)) {
      const scheme = url.match(/^[a-z][a-z0-9+.-]*(?=:\/\/)/i)?.[0];
      const found = scheme ? `found "${scheme}://"` : "no URL scheme found";
      throw new Error(
        `DATABASE_URL is not a Postgres connection string (${found}). Expected postgresql://...`,
      );
    }
  },
});
