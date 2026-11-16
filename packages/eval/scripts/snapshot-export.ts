/**
 * Export the snapshot's production slice (src/snapshot/export.ts): every job that is active right
 * now, with the tables production's location rule reads. Run ONCE by the owner, during an ingest
 * tick (2-10 minutes past an even UTC hour, when Neon is already awake):
 *
 *   set -a; . ~/.config/opusfinder/db.env; set +a
 *   node --import tsx scripts/snapshot-export.ts          # from packages/eval
 *
 * Read-only (one REPEATABLE READ, READ ONLY transaction). It prints counts, never content. Files go
 * to data/snapshots/<UTC date>/objects/ (gitignored); nothing is uploaded here.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createAuthDb } from "@opusfinder/db/auth-client";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { runScript } from "@opusfinder/shared/script";

import { getFlag } from "../src/cli";
import { relativeToPkg } from "../src/runner";
import { ATS_SELECTION, exportProductionSlice } from "../src/snapshot/export";
import type { SliceRecord } from "../src/snapshot/publish";
import { listObjects, snapshotPaths, type SnapshotPaths } from "../src/snapshot/store";

async function main(): Promise<void> {
  const pool = createAuthDb(getDatabaseUrl()).$client;
  const client = await pool.connect();
  let paths: SnapshotPaths | undefined;
  try {
    const result = await exportProductionSlice(
      client,
      (takenAt) => {
        const id = getFlag(process.argv.slice(2), "--id") ?? takenAt.slice(0, 10);
        paths = snapshotPaths(id);
        // The record is written last, so it marks a finished export. Without it, anything already
        // there is a run that died part-way: cleared, so no stale part outlives a re-run.
        if (existsSync(join(paths.work, "slice-ats.json"))) {
          throw new Error(
            `${relativeToPkg(paths.objects)} already holds a finished export. A snapshot is ` +
              `exported once; pass --id <another date> for a new one.`,
          );
        }
        for (const path of listObjects(paths.objects)) {
          if (/^(jobs\/ats-|companies\/|location-strings\/|places\/)/.test(path)) {
            rmSync(join(paths.objects, path));
          }
        }
        console.error(`snapshot ${id}: exporting at ${takenAt} (read-only transaction)`);
        return paths.objects;
      },
      (line) => console.error(line),
    );
    if (!paths) throw new Error("the export named no snapshot.");

    // What the publish step can't re-derive from the objects: when and how the slice was chosen.
    const record: SliceRecord = { selection: ATS_SELECTION, takenAt: result.takenAt };
    mkdirSync(paths.work, { recursive: true });
    writeFileSync(join(paths.work, "slice-ats.json"), `${JSON.stringify(record, null, 2)}\n`);

    console.error(`\nexported to ${relativeToPkg(paths.objects)}`);
    console.error(`  active jobs: ${result.jobs}`);
    console.error(`  by source:   ${JSON.stringify(result.bySource)}`);
    console.error(`  flagged:     ${JSON.stringify(result.byFlag)}`);
    console.error(`  tables:      ${JSON.stringify(result.tables)}`);
  } finally {
    client.release(true);
    await pool.end();
  }
}

await runScript("SnapshotExport", main);
