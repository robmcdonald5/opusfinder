import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { runScript } from "@opusfinder/shared/script";

import { createLocationModel, loadGazetteer, syncLocationStrings } from "../src/index";

/**
 * The digest's daily location step, by hand: resolve every active (company, raw) pair that has no row
 * yet, a chunk at a time, until none are left.
 *
 *   pnpm locations:sync
 */
await runScript("locations:sync", async () => {
  const db = createDb(getDatabaseUrl());
  const model = createLocationModel();
  const gazetteer = await loadGazetteer(db);
  const total = { resolved: 0, unanswered: 0, unmatchedPlaces: 0 };
  for (;;) {
    const chunk = await syncLocationStrings(db, model, { gazetteer });
    total.resolved += chunk.resolved;
    total.unanswered += chunk.unanswered;
    total.unmatchedPlaces += chunk.unmatchedPlaces;
    console.log(`  +${chunk.resolved} resolved, +${chunk.unanswered} with no answer`);
    if (!chunk.more) break;
  }
  console.log(
    `locations:sync: ${total.resolved} resolved, ${total.unanswered} with no answer, ` +
      `${total.unmatchedPlaces} place(s) failed the GeoNames check. See pnpm locations:report.`,
  );
});
