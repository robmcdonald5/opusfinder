import { parseArgs } from "node:util";

import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { getPlaces } from "@opusfinder/db/repos";
import { runScript } from "@opusfinder/shared/script";

import { recheckLocationStrings } from "../src/index";

/**
 * Re-run the GeoNames check over the places stored answers failed, without the model: run it after
 * `places:load` or a change to the check or the area list. Free and quick; writes only the rows it changes
 * (owner-run).
 *
 *   pnpm locations:recheck              (re-check and store)
 *   pnpm locations:recheck -- --dry-run (show what would change)
 */
await runScript("locations:recheck", async () => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { "dry-run": { type: "boolean" } },
  });
  const db = createDb(getDatabaseUrl());
  const dryRun = values["dry-run"] === true;
  const result = await recheckLocationStrings(db, { dryRun });
  const names = new Map(
    (await getPlaces(db, [...new Set(result.updates.flatMap((u) => u.placeIds))])).map((p) => [
      p.geonamesId,
      [p.name, p.regionName, p.countryCode].filter(Boolean).join(", "),
    ]),
  );
  for (const u of result.updates) {
    console.log(
      `  ${JSON.stringify(u.raw)} → ${u.placeIds.map((id) => names.get(id) ?? id).join(" | ") || "no place"}` +
        `${u.remoteCountries.length ? ` · remote: ${u.remoteCountries.length} countries` : ""}` +
        `${u.unmatched.length ? ` · still unmatched: ${u.unmatched.length}` : ""}`,
    );
  }
  console.log(
    `locations:recheck${dryRun ? " (dry run, nothing written)" : ""}: ${result.rows} rows with unmatched ` +
      `places; ${result.recovered} place(s) now pass, on ${result.changed} row(s); ${result.stillUnmatched} still unmatched.`,
  );
});
