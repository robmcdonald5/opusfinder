import { getTableName } from "drizzle-orm";

import { runScript } from "@opusfinder/shared/script";
import { createS3StorageClient } from "@opusfinder/storage";

import { BACKUP_TABLES } from "../src/backup";
import { getDatabaseUrl, getRestoreDatabaseUrl } from "../src/env";
import { getBackupR2Config, restoreBackup } from "./lib/backup";

// OWNER: the restore drill, and a real restore onto a Neon branch (packages/db/README.md "Backups"), with the
// PostgreSQL client tools of the server's major version on PATH:
//   set -a; . ~/.config/opusfinder/db.env; . ~/.config/opusfinder/backup-r2.env; set +a
//   pnpm --filter @opusfinder/db run backup:restore          (add -- --date=YYYY-MM-DD for an older dump)
// with RESTORE_DATABASE_URL exported: the branch's connection string. Restores the newest recorded backup, or
// the one from --date, into that database in one transaction (scripts/lib/backup.ts restoreBackup), then
// compares each table's row count with production's and exits 1 on any difference. Refuses a
// RESTORE_DATABASE_URL that reaches production's database. Prints table names, counts and the dump's key only.

/** `--date=YYYY-MM-DD` as that UTC day, or undefined for the newest backup. */
function parseDate(args = process.argv.slice(2)): Date | undefined {
  const rest = args.filter((arg) => arg !== "--");
  const date = /^--date=(\d{4}-\d{2}-\d{2})$/.exec(rest[0] ?? "")?.[1];
  if (rest.length > 1 || (rest.length === 1 && !date)) {
    throw new Error("the only option is --date=YYYY-MM-DD");
  }
  return date ? new Date(`${date}T00:00:00Z`) : undefined;
}

await runScript("backup restore", async () => {
  const date = parseDate();
  const prodUrl = getDatabaseUrl();
  const restoreUrl = getRestoreDatabaseUrl();
  const storage = createS3StorageClient(getBackupR2Config());
  let result;
  try {
    result = await restoreBackup({ prodUrl, restoreUrl, storage, date });
  } finally {
    storage.close();
  }

  const { key, bytes, restored, production } = result;
  console.log(`Restored ${key} (${bytes} bytes).`);
  const names = BACKUP_TABLES.map((t) => getTableName(t));
  const width = Math.max(...names.map((n) => n.length));
  console.log(`${"table".padEnd(width)}  restored  production`);
  const differ = names.filter((name) => {
    const same = restored[name] === production[name];
    console.log(
      `${name.padEnd(width)}  ${String(restored[name]).padStart(8)}  ${String(production[name]).padStart(10)}` +
        (same ? "" : "  DIFFERS"),
    );
    return !same;
  });
  if (differ.length > 0) {
    console.error(
      `Row counts differ for ${differ.join(", ")}: production changed since the dump, or the restore is incomplete.`,
    );
    process.exitCode = 1;
  } else {
    console.log("Row counts match production.");
  }
});
