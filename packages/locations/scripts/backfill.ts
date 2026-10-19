import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { pairStatus } from "@opusfinder/db/repos";
import { runScript } from "@opusfinder/shared/script";

import { backfillLocationStrings, createLocationModel, PROMPT_VERSION } from "../src/index";

/**
 * Resolve every active (company, raw) pair that has no row, a row from another prompt version, or a row
 * the model gave no answer for, as ONE provider batch (half price; can take minutes to hours). Re-run it
 * after a prompt-version bump; pairs whose request never completed are left for the next run.
 *
 *   pnpm locations:backfill              (submit, wait, store)
 *   pnpm locations:backfill -- --dry-run (count the pairs it would send)
 */
await runScript("locations:backfill", async () => {
  const db = createDb(getDatabaseUrl());
  const status = await pairStatus(db, PROMPT_VERSION);
  console.log(
    `prompt version ${PROMPT_VERSION}: ${status.active} active pairs; ${status.missing} without a row, ` +
      `${status.stale} from another version, ${status.unresolved} with no answer.`,
  );
  if (process.argv.includes("--dry-run")) return;

  console.log("Submitting one batch and waiting for it to end…");
  const { counts, outcomes } = await backfillLocationStrings(db, createLocationModel());
  console.log(
    `locations:backfill: ${counts.resolved} resolved, ${counts.unanswered} with no answer, ` +
      `${counts.failed} request(s) that never completed, ${counts.unmatchedPlaces} place(s) failed the GeoNames check.`,
  );
  const problems = outcomes.filter((o) => o.problem);
  if (problems.length > 0) {
    console.log("\nPairs without an answer (company · text · why):");
    for (const o of problems) {
      console.log(
        `  ${o.pair.companySlug} · ${JSON.stringify(o.pair.raw)} · ${o.problem}${o.row ? "" : " (no row; retried next run)"}`,
      );
    }
  }
});
