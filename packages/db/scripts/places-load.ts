import { parseArgs } from "node:util";

import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";
import { loadGeonames } from "../src/geonames-files";
import { upsertPlaces } from "../src/repos/places";

/**
 * Load the GeoNames gazetteer into `places`: countries, first-level regions, every city of 500+ people,
 * and every other US populated place (the US dump; ~160k small towns and communities). Downloads
 * cities500.zip, US.zip (~70 MB), admin1CodesASCII.txt and countryInfo.txt from download.geonames.org
 * (CC BY 4.0), checks every field, and upserts by geonames_id. Never deletes, so it is safe to re-run to
 * pick up GeoNames' updates, and a home place a user points at can't disappear. Run `pnpm
 * locations:recheck` afterwards: stored answers whose places were missing can pass now.
 *
 *   pnpm --filter @opusfinder/db run places:load
 *   pnpm --filter @opusfinder/db run places:load -- --from <dir>   (use already-downloaded files)
 */
await runScript("places:load", async () => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { from: { type: "string" } },
  });
  const { rows, summary } = await loadGeonames({ from: values.from });
  for (const s of summary)
    console.log(`${s.label}: ${s.parsed} parsed, ${s.skipped} malformed line(s) skipped`);
  const db = createDb(getDatabaseUrl());
  console.log(`places:load upserted ${await upsertPlaces(db, rows)} places.`);
});
