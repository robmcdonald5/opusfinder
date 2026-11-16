/**
 * Publish a snapshot: describe the local objects in data/snapshots/<id>/manifest.json (the one file
 * to commit) and upload them to the private eval bucket under jobs/<id>/.
 *
 *   pnpm --filter @opusfinder/eval snapshot:publish -- --id 2026-11-16
 *   pnpm --filter @opusfinder/eval snapshot:publish -- --id 2026-11-16 --dry-run   # manifest only, no upload
 *
 * Safe to repeat: only objects the existing manifest doesn't list are uploaded (a later slice or
 * model), and a published object is never replaced. Prints counts and paths, never job text.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runScript } from "@opusfinder/shared/script";
import { createS3StorageClient } from "@opusfinder/storage";

import { getFlag } from "../src/cli";
import { relativeToPkg } from "../src/runner";
import { getEvalR2Config } from "../src/snapshot/env";
import { SLICES, type SnapshotSlice } from "../src/snapshot/format";
import { parseManifest, serializeManifest } from "../src/snapshot/manifest";
import {
  buildManifest,
  uploadSnapshot,
  verifySnapshot,
  type SliceRecord,
} from "../src/snapshot/publish";
import { snapshotPaths } from "../src/snapshot/store";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const id = getFlag(args, "--id");
  if (!id) throw new Error("--id <snapshot date> is required.");
  const dryRun = args.includes("--dry-run");
  const paths = snapshotPaths(id);

  const sliceRecords: Partial<Record<SnapshotSlice, SliceRecord>> = {};
  for (const slice of SLICES) {
    const record = join(paths.work, `slice-${slice}.json`);
    if (existsSync(record))
      sliceRecords[slice] = JSON.parse(readFileSync(record, "utf8")) as SliceRecord;
  }

  const manifest = await buildManifest({
    id,
    objectsDir: paths.objects,
    workDir: paths.work,
    sliceRecords,
  });
  // The objects just described are re-read against the manifest before anything leaves the machine.
  const verified = verifySnapshot(manifest, paths.objects);
  const published = existsSync(paths.manifest)
    ? parseManifest(JSON.parse(readFileSync(paths.manifest, "utf8")))
    : null;

  console.error(`snapshot ${id}: ${verified.jobs} jobs, ${verified.objects} objects`);
  for (const [slice, def] of Object.entries(manifest.slices)) {
    console.error(
      `  ${slice}: ${def.jobs} jobs, ${def.uniqueTexts} distinct texts, flags ${JSON.stringify(def.byFlag)}`,
    );
  }
  for (const model of manifest.models) {
    console.error(
      `  ${model.slug}: ${model.dimensions} dims on ${model.host}, ${model.tokens} tokens, $${model.usd.toFixed(4)}`,
    );
  }

  if (dryRun) {
    console.error("dry run: nothing uploaded, manifest not written.");
    return;
  }
  const store = createS3StorageClient(getEvalR2Config());
  try {
    const uploaded = await uploadSnapshot(manifest, published, paths.objects, store, (line) =>
      console.error(line),
    );
    console.error(`uploaded ${uploaded.length} object(s) under ${manifest.bucketPrefix}`);
  } finally {
    store.close();
  }
  // Written only after every upload succeeded, so a committed manifest never lists a missing object.
  writeFileSync(paths.manifest, serializeManifest(manifest));
  console.error(`wrote ${relativeToPkg(paths.manifest)} (commit this file)`);
}

await runScript("SnapshotPublish", main);
