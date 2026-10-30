import { appendFileSync } from "node:fs";

import { runScript } from "@opusfinder/shared/script";
import { createS3StorageClient } from "@opusfinder/storage";

import { BACKUP_TABLES } from "../src/backup";
import { getBackupDatabaseUrl } from "../src/env";
import { getBackupR2Config, runBackup } from "./lib/backup";

// The nightly backup (.github/workflows/backup.yml), as the read-only user_backup role, with the PostgreSQL
// client tools of the server's major version on PATH:
//   pnpm --filter @opusfinder/db run backup:run
// Dumps BACKUP_TABLES (src/backup.ts), uploads the dump to the backup bucket as user-tables/<UTC date>.dump,
// then records it in source_runs, which the backup_staleness health check reads (scripts/lib/backup.ts
// runBackup). Prints the key, the size and the table count only.

await runScript("backup", async () => {
  const url = getBackupDatabaseUrl();
  const storage = createS3StorageClient(getBackupR2Config());
  try {
    const { key, bytes } = await runBackup(url, storage, new Date());
    const line = `Backed up ${BACKUP_TABLES.length} tables (${bytes} bytes) to ${key}.`;
    console.log(line);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) appendFileSync(summary, `${line}\n`);
  } finally {
    storage.close();
  }
});
