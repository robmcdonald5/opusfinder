import { parseArgs } from "node:util";

import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { pairStatus } from "@opusfinder/db/repos";
import { runScript } from "@opusfinder/shared/script";

import {
  BATCH_SIZE,
  backfillLocationStrings,
  collectLocationBatch,
  createLocationModel,
  PROMPT_VERSION,
  type PairOutcome,
  type ResolveCounts,
} from "../src/index";

/**
 * Resolve every active (company, raw) pair that has no row, a row from another prompt version, or a row
 * the model gave no answer for, as provider batches of up to 1,500 (half price; minutes to hours). Each
 * batch is stored as soon as it ends, and its id is printed when it is submitted: if this process dies,
 * or a batch's wait fails, `--collect <id>` stores that batch later without sending anything again. Re-run
 * it after a prompt-version bump; pairs whose request failed are left for the next run.
 *
 *   pnpm locations:backfill                         (submit, wait, store)
 *   pnpm locations:backfill -- --dry-run            (count the pairs it would send)
 *   pnpm locations:backfill -- --collect <batch id> (store an already-submitted batch; repeatable)
 */
await runScript("locations:backfill", async () => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean" },
      collect: { type: "string", multiple: true },
    },
  });
  const db = createDb(getDatabaseUrl());
  const status = await pairStatus(db, PROMPT_VERSION);
  console.log(
    `prompt version ${PROMPT_VERSION}: ${status.active} active pairs; ${status.missing} without a row, ` +
      `${status.stale} from another version, ${status.unresolved} with no answer` +
      `${status.tooLong ? `; ${status.tooLong} too long to resolve` : ""}.`,
  );
  if (values["dry-run"]) return;
  const model = createLocationModel();

  if (values.collect) {
    for (const batchId of values.collect) {
      const { counts, outcomes, skipped } = await collectLocationBatch(db, model, batchId);
      console.log(
        `batch ${batchId}: ${summary(counts)}` +
          `${skipped ? `; ${skipped} answer(s) for pairs no longer pending, not stored` : ""}.`,
      );
      printProblems(outcomes);
    }
    return;
  }

  const pending = status.missing + status.stale + status.unresolved;
  console.log(
    `Submitting ${Math.ceil(pending / BATCH_SIZE)} batch(es) and storing each as it ends. Keep the ids: ` +
      "`--collect <id>` stores a batch this run doesn't.",
  );
  const { counts, outcomes, batches } = await backfillLocationStrings(db, model, {
    onSubmitted: (batchId, pairs) => console.log(`  submitted ${batchId} (${pairs} pairs)`),
  });
  for (const b of batches.filter((b) => b.error)) {
    console.log(
      `  ✗ ${b.batchId ?? "a batch that was never submitted"} (${b.pairs} pairs): ${b.error}` +
        (b.batchId ? " — once it has ended, `--collect` it" : " — the next run sends its pairs"),
    );
  }
  console.log(`locations:backfill: ${summary(counts)}.`);
  printProblems(outcomes);
  if (batches.some((b) => b.error)) process.exitCode = 1;
});

function summary(counts: ResolveCounts): string {
  return (
    `${counts.resolved} resolved, ${counts.unanswered} with no answer, ` +
    `${counts.failed} request(s) that failed (retried next run), ` +
    `${counts.unmatchedPlaces} place(s) failed the GeoNames check`
  );
}

function printProblems(outcomes: PairOutcome[]): void {
  const problems = outcomes.filter((o) => o.problem);
  if (problems.length === 0) return;
  console.log("\nPairs without an answer (company · text · why):");
  for (const o of problems) {
    console.log(
      `  ${o.pair.companySlug} · ${JSON.stringify(o.pair.raw)} · ${o.problem}${o.row ? "" : " (no row; retried next run)"}`,
    );
  }
}
