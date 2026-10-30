import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getTableName } from "drizzle-orm";

import { requireEnv } from "@opusfinder/shared/env";
import type { R2Config, StorageClient } from "@opusfinder/storage";

import {
  BACKUP_TABLES,
  backupObjectKey,
  backupRunSql,
  databaseEndpoint,
  libpqEnv,
  newestBackupSql,
  pgDumpArgs,
  RESTORE_NEEDS,
  restoreList,
  rowCountsSql,
  serverMajorVersion,
  toolMajorVersion,
  truncateSql,
} from "../../src/backup";

/** The backup bucket's settings: secrets in the `backup` GitHub Environment, and in the owner's
 *  ~/.config/opusfinder/backup-r2.env for setup and restores. */
export const BACKUP_R2_ENV = [
  "BACKUP_R2_ACCOUNT_ID",
  "BACKUP_R2_BUCKET",
  "BACKUP_R2_ACCESS_KEY_ID",
  "BACKUP_R2_SECRET_ACCESS_KEY",
] as const;
export type BackupR2Env = Record<(typeof BACKUP_R2_ENV)[number], string>;

/** Every BACKUP_R2_* value, or a throw naming the first one missing. */
export function getBackupR2Env(): BackupR2Env {
  const read = (name: (typeof BACKUP_R2_ENV)[number]) =>
    requireEnv({
      name,
      notSetMessage: `${name} is not set. Export it from ~/.config/opusfinder/backup-r2.env; see packages/db/README.md "Backups".`,
    })();
  return Object.fromEntries(BACKUP_R2_ENV.map((name) => [name, read(name)])) as BackupR2Env;
}

/** The S3 client config for the backup bucket. */
export function getBackupR2Config(): R2Config {
  const env = getBackupR2Env();
  return {
    endpoint: `https://${env.BACKUP_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: env.BACKUP_R2_ACCESS_KEY_ID,
    secretAccessKey: env.BACKUP_R2_SECRET_ACCESS_KEY,
    bucket: env.BACKUP_R2_BUCKET,
  };
}

/**
 * Run a PostgreSQL client tool and return its stdout; its stderr goes to the terminal. With a connection
 * string, the credentials go in the tool's environment (src/backup.ts libpqEnv), never on its command line,
 * and nothing else from this process's environment reaches it but PATH.
 */
export function pgTool(tool: string, args: string[], connectionString?: string): string {
  const env = {
    PATH: process.env.PATH ?? "",
    ...(connectionString ? libpqEnv(connectionString) : {}),
  };
  try {
    return execFileSync(tool, args, {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const { code, status } = err as { code?: string; status?: number | null };
    const why = code === "ENOENT" ? "is not on PATH" : `failed (exit ${String(status)})`;
    throw new Error(`${tool} ${why}`, { cause: err });
  }
}

/** psql with no startup file, stopping at the first error; returns its unaligned, tuples-only output. */
export function psql(connectionString: string, args: string[]): string {
  const base = ["--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1"];
  return pgTool("psql", [...base, ...args], connectionString).trim();
}

/** Throws unless `tool` (pg_dump, pg_restore or psql) is the same major version as the server. */
export function requireMatchingMajor(
  tool: "pg_dump" | "pg_restore" | "psql",
  connectionString: string,
): void {
  const toolMajor = toolMajorVersion(pgTool(tool, ["--version"]));
  const serverMajor = serverMajorVersion(
    psql(connectionString, ["--command=SHOW server_version_num"]),
  );
  if (toolMajor !== serverMajor) {
    throw new Error(
      `${tool} is PostgreSQL ${toolMajor} but the server runs ${serverMajor}: use the ${serverMajor} client tools`,
    );
  }
}

/** A temp directory for `body`, removed afterwards whatever happens. */
async function inTempDir<T>(prefix: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The nightly backup, as `url`'s role: check pg_dump matches the server, dump {@link BACKUP_TABLES}, check the
 * archive holds every table's data, upload it under {@link backupObjectKey}, then record it in source_runs.
 * Nothing is recorded unless the upload succeeded.
 */
export async function runBackup(
  url: string,
  storage: StorageClient,
  startedAt: Date,
): Promise<{ key: string; bytes: number }> {
  requireMatchingMajor("pg_dump", url);
  return inTempDir("user-backup-", async (dir) => {
    const file = join(dir, "backup.dump");
    pgTool("pg_dump", pgDumpArgs(file), url);
    restoreList(pgTool("pg_restore", ["--list", file]));
    const body = readFileSync(file);
    const key = backupObjectKey(startedAt);
    await storage.putObject({ key, body, contentType: "application/octet-stream" });
    psql(url, [
      `--command=${backupRunSql(startedAt, { tables: BACKUP_TABLES.length, bytes: body.length })}`,
    ]);
    return { key, bytes: body.length };
  });
}

/** Each backed-up table's row count; `readOnly` reads them in a read-only transaction. A transaction, not a
 *  session setting, so it can't outlive the read on a pooled connection. */
function rowCounts(url: string, readOnly = false): Record<string, number> {
  const first = readOnly ? ["--single-transaction", "--command=SET TRANSACTION READ ONLY"] : [];
  return JSON.parse(psql(url, [...first, `--command=${rowCountsSql()}`])) as Record<string, number>;
}

export interface RestoreResult {
  key: string;
  bytes: number;
  /** Row counts per backed-up table, after the restore and in production (read-only). */
  restored: Record<string, number>;
  production: Record<string, number>;
}

/**
 * Restore a dump into `restoreUrl`: the one dated `date` (its UTC day), or the newest recorded in production.
 * Refuses a `restoreUrl` that reaches `prodUrl`'s database, a pg_restore that isn't the server's major version,
 * and a restore database missing {@link RESTORE_NEEDS}. In ONE transaction it empties the backed-up tables
 * (and session, which points at user), then loads the dump's data, parents first, so a failure changes
 * nothing. Production is only read, in a read-only session.
 */
export async function restoreBackup(opts: {
  prodUrl: string;
  restoreUrl: string;
  storage: StorageClient;
  date?: Date;
}): Promise<RestoreResult> {
  const { prodUrl, restoreUrl, storage } = opts;
  if (databaseEndpoint(restoreUrl) === databaseEndpoint(prodUrl)) {
    throw new Error(
      "RESTORE_DATABASE_URL reaches the same database as DATABASE_URL (production): use a branch's connection string",
    );
  }
  // psql runs pg_restore's script, which uses meta-commands only psql of the same release knows.
  requireMatchingMajor("pg_restore", restoreUrl);
  requireMatchingMajor("psql", restoreUrl);
  for (const table of RESTORE_NEEDS) {
    const name = getTableName(table);
    if (psql(restoreUrl, [`--command=SELECT count(*) FROM public."${name}"`]) === "0") {
      throw new Error(`${name} is empty on the restore database: load it first`);
    }
  }

  let date = opts.date;
  if (!date) {
    const newest = psql(prodUrl, [`--command=${newestBackupSql()}`]);
    if (!newest) throw new Error("production has no recorded backup yet: run the backup first");
    date = new Date(JSON.parse(newest) as string);
  }
  const key = backupObjectKey(date);
  const bytes = await inTempDir("user-restore-", async (dir) => {
    const body = await storage.getObject(key);
    if (!body) throw new Error(`no dump at ${key} (the bucket keeps 14 days)`);
    const dump = join(dir, "backup.dump");
    const list = join(dir, "restore.list");
    const script = join(dir, "restore.sql");
    writeFileSync(dump, body);
    writeFileSync(list, restoreList(pgTool("pg_restore", ["--list", dump])));
    pgTool("pg_restore", ["--data-only", `--use-list=${list}`, `--file=${script}`, dump]);
    psql(restoreUrl, ["--single-transaction", `--command=${truncateSql()}`, `--file=${script}`]);
    return body.length;
  });
  return { key, bytes, restored: rowCounts(restoreUrl), production: rowCounts(prodUrl, true) };
}
