/**
 * Embed a snapshot's jobs with ONE model (paid). Run per model, so the reference and each challenger
 * are separate runs that never touch each other's files:
 *
 *   pnpm --filter @opusfinder/eval snapshot:embed -- --id 2026-11-16 --model qwen3-embedding-8b --max-usd 5
 *
 * --max-usd is required and has no default: it is the approved total, at list prices, across every
 * model and run recorded in this snapshot's work/spend.jsonl. The run stops before a request that
 * would pass it (exit code 2) and keeps what it finished; a re-run resumes. See src/snapshot/embed-run.ts.
 * Prints progress and spend. It prints no job text of its own; a host's error message is shown as
 * received (first 500 characters).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { runScript } from "@opusfinder/shared/script";

import { getFlag } from "../src/cli";
import {
  isSnapshotModelSlug,
  resolveSnapshotModel,
  SNAPSHOT_MODEL_SLUGS,
} from "../src/embedders/snapshot-models";
import { embedSlice } from "../src/snapshot/embed-run";
import { SLICES, type SnapshotSlice } from "../src/snapshot/format";
import { listJobsParts, snapshotPaths } from "../src/snapshot/store";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const id = getFlag(args, "--id");
  const slug = getFlag(args, "--model") ?? "";
  const maxUsd = Number(getFlag(args, "--max-usd"));
  const only = getFlag(args, "--slice");
  const concurrency = Number(getFlag(args, "--concurrency") ?? 4);
  if (!id) throw new Error("--id <snapshot date> is required.");
  if (!isSnapshotModelSlug(slug)) {
    throw new Error(`--model must be one of: ${SNAPSHOT_MODEL_SLUGS.join(", ")}.`);
  }
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
    throw new Error("--max-usd <approved total in USD> is required.");
  }
  if (only !== undefined && !SLICES.includes(only as SnapshotSlice)) {
    throw new Error(`--slice must be one of: ${SLICES.join(", ")}.`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("--concurrency must be 1 or more.");

  const paths = snapshotPaths(id);
  const slices = SLICES.filter(
    (s) => (only === undefined || s === only) && listJobsParts(paths.objects, s).length > 0,
  );
  if (slices.length === 0) throw new Error(`snapshot ${id} has no jobs to embed; export it first.`);
  // A slice's record is written last by its export or fetch: without it the jobs parts may be a run
  // that died part-way, and paying to embed those would be for nothing.
  for (const slice of slices) {
    if (!existsSync(join(paths.work, `slice-${slice}.json`))) {
      throw new Error(
        `the ${slice} slice of snapshot ${id} isn't finished (no work/slice-${slice}.json).`,
      );
    }
  }

  const model = await resolveSnapshotModel(slug);
  console.error(
    `${model.id} on ${model.host}: ${model.dimensions} dims, $${model.pricePerMTokUsd}/1M tokens; ` +
      `cap $${maxUsd.toFixed(2)} across all models`,
  );
  for (const slice of slices) {
    const result = await embedSlice({
      objectsDir: paths.objects,
      workDir: paths.work,
      slice,
      model,
      maxUsd,
      concurrency,
      log: (line) => console.error(line),
    });
    if (result.status === "stopped_at_cap") {
      process.exitCode = 2;
      return;
    }
  }
}

await runScript("SnapshotEmbed", main);
