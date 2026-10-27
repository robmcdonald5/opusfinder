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
    "DATABASE_URL is not set. Export it from a file outside the repo (set -a; . ~/.config/opusfinder/db.env; set +a); don't keep the owner URL in packages/db/.env, where agents can read it.",
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

/**
 * Read + validate BACKUP_DATABASE_URL: the read-only `user_backup` role's direct connection string, which only
 * the `backup` GitHub Environment holds (set by `backup:setup`). The nightly backup reads this and never falls
 * back to DATABASE_URL.
 */
export const getBackupDatabaseUrl = requireEnv({
  name: "BACKUP_DATABASE_URL",
  notSetMessage:
    'BACKUP_DATABASE_URL is not set. It lives in the backup GitHub Environment; see packages/db/README.md "Backups".',
  validate: validatePostgresUrl("BACKUP_DATABASE_URL"),
});

/**
 * Read + validate RESTORE_DATABASE_URL: the database `backup:restore` empties and loads a dump into (a Neon
 * branch for the drill). Never production: the restore refuses a URL that reaches DATABASE_URL's database.
 */
export const getRestoreDatabaseUrl = requireEnv({
  name: "RESTORE_DATABASE_URL",
  notSetMessage:
    'RESTORE_DATABASE_URL is not set. Export the connection string of the Neon branch to restore into; see packages/db/README.md "Backups".',
  validate: validatePostgresUrl("RESTORE_DATABASE_URL"),
});
