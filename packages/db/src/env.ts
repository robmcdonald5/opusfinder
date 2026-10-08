import { loadPackageEnv, requireEnv } from "@opusfinder/shared/env";

// Load packages/db/.env relative to THIS module (see loadPackageEnv), so any package's
// scripts — not just db's — pick up DATABASE_URL regardless of the cwd they run from.
loadPackageEnv(import.meta.url);

/**
 * The shared format check: throws unless `url` is a postgres(ql):// URL, echoing only the URL scheme
 * (never the credentials after "://"), so the secret never lands in logs/CI output.
 */
function validatePostgresUrl(name: string): (url: string) => void {
  return (url) => {
    if (!/^postgres(ql)?:\/\//i.test(url)) {
      const scheme = url.match(/^[a-z][a-z0-9+.-]*(?=:\/\/)/i)?.[0];
      const found = scheme ? `found "${scheme}://"` : "no URL scheme found";
      throw new Error(
        `${name} is not a Postgres connection string (${found}). Expected postgresql://...`,
      );
    }
  };
}

/** Read + validate DATABASE_URL (the owner's connection string). */
export const getDatabaseUrl = requireEnv({
  name: "DATABASE_URL",
  notSetMessage:
    "DATABASE_URL is not set. Copy the repo-root .env.example to packages/db/.env and paste your Neon connection string.",
  validate: validatePostgresUrl("DATABASE_URL"),
});

/**
 * Read + validate DATA_FIX_DATABASE_URL: the limited `data_fixer` role's connection string, which only the
 * `data-fixes` GitHub Environment holds (set by `data-fixer:setup`). The fix runner reads this and never falls
 * back to DATABASE_URL, so it can't run with the owner's privileges.
 */
export const getDataFixDatabaseUrl = requireEnv({
  name: "DATA_FIX_DATABASE_URL",
  notSetMessage:
    "DATA_FIX_DATABASE_URL is not set. It lives in the data-fixes GitHub Environment; see packages/db/fixes/README.md.",
  validate: validatePostgresUrl("DATA_FIX_DATABASE_URL"),
});
