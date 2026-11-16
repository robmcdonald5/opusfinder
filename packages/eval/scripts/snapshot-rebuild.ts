/**
 * Rebuild a snapshot from its committed manifest: download every object it lists from the eval
 * bucket (keeping local ones that already match), verify each one's size and SHA-256, then load
 * them all and check they line up. Any difference stops the run with the object's name.
 *
 *   pnpm --filter @opusfinder/eval snapshot:rebuild -- --id 2026-11-16
 *   pnpm --filter @opusfinder/eval snapshot:rebuild -- --id 2026-11-16 --offline   # verify local files only
 *
 * Needs the EVAL_R2_* settings in packages/eval/.env unless --offline.
 */
import { readFileSync } from "node:fs";

import { runScript } from "@opusfinder/shared/script";
import { createS3StorageClient } from "@opusfinder/storage";

import { getFlag } from "../src/cli";
import { relativeToPkg } from "../src/runner";
import { getEvalR2Config } from "../src/snapshot/env";
import { parseManifest } from "../src/snapshot/manifest";
import { downloadSnapshot, verifySnapshot } from "../src/snapshot/publish";
import { snapshotPaths } from "../src/snapshot/store";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const id = getFlag(args, "--id");
  if (!id) throw new Error("--id <snapshot date> is required.");
  const paths = snapshotPaths(id);
  const manifest = parseManifest(JSON.parse(readFileSync(paths.manifest, "utf8")));

  if (!args.includes("--offline")) {
    const store = createS3StorageClient(getEvalR2Config());
    try {
      const { kept, downloaded } = await downloadSnapshot(manifest, paths.objects, store, (line) =>
        console.error(line),
      );
      console.error(`${downloaded} object(s) downloaded, ${kept} already present and matching`);
    } finally {
      store.close();
    }
  }

  const verified = verifySnapshot(manifest, paths.objects);
  console.error(`snapshot ${id} verified in ${relativeToPkg(paths.objects)}:`);
  console.error(`  ${verified.objects} objects match their SHA-256`);
  console.error(`  ${verified.jobs} jobs`);
  for (const [slug, vectors] of Object.entries(verified.vectors)) {
    console.error(`  ${slug}: ${vectors} vectors`);
  }
}

await runScript("SnapshotRebuild", main);
