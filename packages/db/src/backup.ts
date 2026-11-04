import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  account,
  digestItems,
  digestRuns,
  digests,
  places,
  session,
  user,
  userCvFiles,
  userPreferences,
  userProfiles,
  type RunCounts,
  type RunPipeline,
} from "./schema";

/**
 * The nightly user-table backup (.github/workflows/backup.yml): what it dumps, where the dump goes, and how a
 * dump goes back in. Pure: no process, no I/O. The scripts that run pg_dump / pg_restore / psql are
 * scripts/backup-*.ts; the role that dumps is `USER_BACKUP` (roles.ts).
 *
 * Every table in schema.ts is either here or in {@link NOT_BACKED_UP} (backup.test.ts fails otherwise). A
 * table added to this list needs `backup:setup` re-run after its migration, so the role can read it.
 */

/** The tables holding user-owned data, parents before children: a restore loads them in this order, so each
 *  foreign key finds its row (backup.test.ts pins the order against the schema's foreign keys). */
export const BACKUP_TABLES: readonly PgTable[] = [
  user,
  account,
  userCvFiles,
  userProfiles,
  userPreferences,
  digestRuns,
  digests,
  digestItems,
];

/** Every other table, with why it isn't backed up. */
export const NOT_BACKED_UP: Readonly<Record<string, string>> = {
  session: "short-lived sign-in tokens: after a restore, users sign in again",
  verification: "short-lived email tokens",
  companies: "discovery finds the boards again",
  jobs: "ingestion fetches the postings again",
  places: "reference data that places:load reloads",
  location_strings: "the location normalizer resolves them again",
  source_runs: "operational log",
  health_alerts: "operational log",
  data_fixes: "operational log of fixes to job-side data",
};

/** Tables a backed-up table has a foreign key to that the dump doesn't hold. They must be loaded before a
 *  restore: `user_preferences.home_place_id` points at `places`. */
export const RESTORE_NEEDS: readonly PgTable[] = [places];

/** Tables the dump doesn't hold that have a foreign key to a backed-up table: a restore empties them along with
 *  the backed-up tables. Signed-in sessions end; users sign in again. */
export const RESTORE_EMPTIES: readonly PgTable[] = [session];

/** The `source_runs.pipeline` of a backup's record. */
export const BACKUP_PIPELINE: RunPipeline = "backup";

/** The R2 key of the dump taken at `at`: one per UTC day, so a second run that day replaces the first. */
export function backupObjectKey(at: Date): string {
  return `user-tables/${at.toISOString().slice(0, 10)}.dump`;
}

/** A `YYYY-MM-DD` as the start of that UTC day. Throws on an impossible day, which Date would roll over into
 *  another one (02-30 → 03-02) and so pick another day's dump. */
export function utcDay(date: string): Date {
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) {
    throw new Error(`${date} is not a real date`);
  }
  return day;
}

/** pg_dump's arguments: a custom-format archive of exactly {@link BACKUP_TABLES}, schema and data. A table
 *  that doesn't exist fails the dump (--strict-names) instead of being skipped. */
export function pgDumpArgs(file: string): string[] {
  return [
    "--format=custom",
    "--strict-names",
    "--no-password",
    ...BACKUP_TABLES.map((t) => `--table=public."${getTableName(t)}"`),
    `--file=${file}`,
  ];
}

/** The libpq environment variable for each connection-string parameter the backup tools accept. */
const LIBPQ_PARAMS: Readonly<Record<string, string>> = {
  sslmode: "PGSSLMODE",
  channel_binding: "PGCHANNELBINDING",
  options: "PGOPTIONS",
};

/**
 * A postgres:// connection string as libpq environment variables, so pg_dump / pg_restore / psql get the
 * credentials through their environment and never on a command line. SSL defaults to `require`. Throws on a
 * parameter it doesn't know, naming the parameter only, so nothing is silently dropped.
 */
export function libpqEnv(connectionString: string): Record<string, string> {
  const url = new URL(connectionString);
  const env: Record<string, string> = {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: "require",
  };
  const database = decodeURIComponent(url.pathname.slice(1));
  if (database) env.PGDATABASE = database;
  for (const [key, value] of url.searchParams) {
    const name = LIBPQ_PARAMS[key];
    if (!name) throw new Error(`unsupported connection string parameter "${key}"`);
    env[name] = value;
  }
  return env;
}

/** The connection string with a Neon pooler host swapped for its direct endpoint: pg_dump can't run through
 *  the pooler's transaction mode. */
export function directUrl(connectionString: string): string {
  const url = new URL(connectionString);
  url.hostname = url.hostname.replace(/-pooler(?=\.)/, "");
  return url.toString();
}

/** Where a connection string lands: direct host, port and database. Two strings with the same endpoint reach
 *  the same database. */
export function databaseEndpoint(connectionString: string): string {
  const url = new URL(directUrl(connectionString));
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

/** The major version in `pg_dump --version` style output ("pg_dump (PostgreSQL) 18.6" → 18). */
export function toolMajorVersion(versionOutput: string): number {
  const match = /\(PostgreSQL\) (\d+)/.exec(versionOutput);
  if (!match) throw new Error(`unrecognised version output: ${versionOutput.slice(0, 80)}`);
  return Number(match[1]);
}

/** `SHOW server_version_num` (180006) → 18. */
export function serverMajorVersion(serverVersionNum: string): number {
  const n = Number(serverVersionNum.trim());
  if (!Number.isInteger(n) || n < 100000) {
    throw new Error(`unrecognised server_version_num: ${serverVersionNum.slice(0, 20)}`);
  }
  return Math.floor(n / 10000);
}

// One `pg_restore --list` entry: `<dumpId>; <tableoid> <oid> <desc> <schema> <name> <owner>`.
const TOC_ENTRY_RE = /^\d+; \d+ \d+ (TABLE DATA|SEQUENCE SET) (\S+) (\S+) /;

/**
 * The `pg_restore --use-list` file for a data-only restore of a dump, from its `pg_restore --list` output:
 * each table's data in {@link BACKUP_TABLES} order, then the sequence positions. A data-only restore loads
 * into tables whose foreign keys already exist, and pg_dump orders a schema-and-data archive's data by name,
 * not by foreign key. Throws if the archive is missing a table's data or holds a table this list doesn't
 * know, so a dump that wouldn't restore whole fails here.
 */
export function restoreList(toc: string): string {
  const order = BACKUP_TABLES.map((t) => getTableName(t));
  const data = new Map<string, string>();
  const sequences: string[] = [];
  for (const line of toc.split(/\r?\n/)) {
    const match = TOC_ENTRY_RE.exec(line);
    if (!match || match[2] !== "public") continue;
    const [, desc, , name] = match as unknown as [string, string, string, string];
    if (desc === "SEQUENCE SET") sequences.push(line);
    else if (order.includes(name)) data.set(name, line);
    else throw new Error(`the archive holds data for table ${name}, which isn't in BACKUP_TABLES`);
  }
  const missing = order.filter((name) => !data.has(name));
  if (missing.length > 0) throw new Error(`the archive has no data for ${missing.join(", ")}`);
  return [...order.map((name) => data.get(name)!), ...sequences].join("\n") + "\n";
}

/** The TRUNCATE that empties the backed-up tables, and {@link RESTORE_EMPTIES}, before a restore loads them.
 *  No CASCADE: any other table pointing at them makes it fail, instead of being emptied unannounced. */
export function truncateSql(): string {
  const tables = [...BACKUP_TABLES, ...RESTORE_EMPTIES].map((t) => `public."${getTableName(t)}"`);
  return `TRUNCATE ${tables.join(", ")};`;
}

/** One JSON object of each backed-up table's row count. */
export function rowCountsSql(): string {
  const counts = BACKUP_TABLES.map((t) => {
    const name = getTableName(t);
    return `'${name}', (SELECT count(*) FROM public."${name}")`;
  });
  return `SELECT json_build_object(${counts.join(", ")});`;
}

/** The newest recorded backup's start time, as one JSON string (no row: no output). */
export function newestBackupSql(): string {
  return (
    "SELECT to_json(started_at) FROM public.source_runs " +
    `WHERE pipeline = '${BACKUP_PIPELINE}' AND status = 'ok' ORDER BY finished_at DESC LIMIT 1;`
  );
}

/**
 * The record of a finished backup: a `source_runs` row that the backup_staleness health check reads. A plain
 * INSERT with no RETURNING, so the role needs INSERT on source_runs and nothing else there. The values are
 * a Date and numbers, never input text.
 */
export function backupRunSql(startedAt: Date, counts: RunCounts): string {
  for (const [key, value] of Object.entries(counts)) {
    if (!/^[a-z][A-Za-z]*$/.test(key) || !Number.isFinite(value)) {
      throw new Error(`bad backup count ${key}`);
    }
  }
  return (
    "INSERT INTO public.source_runs (pipeline, status, started_at, finished_at, counts) " +
    `VALUES ('${BACKUP_PIPELINE}', 'ok', '${startedAt.toISOString()}', now(), '${JSON.stringify(counts)}'::jsonb);`
  );
}
