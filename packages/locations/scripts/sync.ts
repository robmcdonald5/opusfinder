import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import type { LocationPairKey } from "@opusfinder/db/repos";
import { runScript } from "@opusfinder/shared/script";

import { createLocationModel, loadGazetteer, syncLocationStrings } from "../src/index";

/**
 * The digest's daily location step, by hand: resolve every active (company, raw) pair that has no row
 * yet, a chunk at a time, until none are left. A pair whose request fails is skipped for the rest of the
 * run and asked again next time.
 *
 *   pnpm locations:sync
 */
await runScript("locations:sync", async () => {
  const db = createDb(getDatabaseUrl());
  const model = createLocationModel();
  const gazetteer = await loadGazetteer(db);
  const total = { resolved: 0, unanswered: 0, failed: 0, unmatchedPlaces: 0 };
  const failedPairs: LocationPairKey[] = [];
  for (;;) {
    const chunk = await syncLocationStrings(db, model, { gazetteer, exclude: failedPairs });
    total.resolved += chunk.resolved;
    total.unanswered += chunk.unanswered;
    total.failed += chunk.failed;
    total.unmatchedPlaces += chunk.unmatchedPlaces;
    failedPairs.push(...chunk.failedPairs);
    console.log(
      `  +${chunk.resolved} resolved, +${chunk.unanswered} with no answer, +${chunk.failed} failed`,
    );
    if (!chunk.more) break;
  }
  console.log(
    `locations:sync: ${total.resolved} resolved, ${total.unanswered} with no answer, ` +
      `${total.failed} failed (asked again next run), ` +
      `${total.unmatchedPlaces} place(s) failed the GeoNames check. See pnpm locations:report.`,
  );
});
