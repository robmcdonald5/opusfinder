import { parseArgs } from "node:util";

import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { findHomePlace, updatePreferences, type HomeCandidate } from "@opusfinder/db/repos";
import { runScript } from "@opusfinder/shared/script";

import { findUserIdByEmail } from "../src/index";
import { maskEmail, prefsFromFlags } from "./cli-utils";

const USAGE =
  "Usage: pnpm user:set-prefs --email <email> [--location-mode any|remote_only|onsite_only] " +
  "[--home 'City, Region' | <geonames id> | none] [--radius-miles 50] " +
  "[--min-salary N|clear] [--max-salary N|clear] [--min-yoe N|clear] [--max-yoe N|clear] " +
  "[--dealbreakers a,b] [--exclusions a,b] [--recency-days 14] [--cadence daily|weekly|monthly] [--enabled true|false]";

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      email: { type: "string" },
      "location-mode": { type: "string" },
      home: { type: "string" },
      "radius-miles": { type: "string" },
      "min-salary": { type: "string" },
      "max-salary": { type: "string" },
      "min-yoe": { type: "string" },
      "max-yoe": { type: "string" },
      dealbreakers: { type: "string" },
      exclusions: { type: "string" },
      "recency-days": { type: "string" },
      cadence: { type: "string" },
      enabled: { type: "string" },
    },
  });

  const email = values.email?.trim();
  if (!email) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const db = createDb(getDatabaseUrl());
  const userId = await findUserIdByEmail(db, email);
  if (!userId) {
    console.error(`No user with email ${maskEmail(email)}.`);
    process.exitCode = 1;
    return;
  }

  const patch = prefsFromFlags(values);
  let home: HomeCandidate | null = null;
  if (values.home !== undefined) {
    if (values.home.trim().toLowerCase() === "none") {
      patch.homePlaceId = null;
    } else {
      // Deterministic lookup in `places`: the home is set only when exactly one city matches.
      const found = await findHomePlace(db, values.home);
      if (!("place" in found)) {
        console.error(
          found.candidates.length === 0
            ? `No city matches --home ${JSON.stringify(values.home)}. Try "City, Region" or "City, Region, Country".`
            : `--home ${JSON.stringify(values.home)} matches more than one city (largest first); ` +
                "add the region or country, or pass the GeoNames id:\n" +
                found.candidates.map((c) => `  ${describePlace(c)}`).join("\n"),
        );
        process.exitCode = 1;
        return;
      }
      home = found.place;
      patch.homePlaceId = home.geonamesId;
    }
  }
  if (Object.keys(patch).length === 0) {
    console.error("No preference flags provided — nothing to update.");
    process.exitCode = 1;
    return;
  }

  const row = await updatePreferences(db, userId, patch);
  console.log(`updated prefs for ${maskEmail(email)} (${userId})`);
  if (home) console.log(`  home: ${describePlace(home)}`);
  // Free-text arrays (dealbreakers/exclusions) may carry company names — echo COUNTS, not contents (PII).
  console.log(
    `  location_mode=${row.locationMode} home_place_id=${row.homePlaceId ?? "—"} radius_miles=${row.radiusMiles} ` +
      `salary=[${row.minSalary ?? "—"}..${row.maxSalary ?? "—"}] yoe=[${row.yoeMin ?? "—"}..${row.yoeMax ?? "—"}] ` +
      `recency_days=${row.recencyDays} ` +
      `dealbreakers=${row.dealbreakers.length} exclusions=${row.exclusions.length} ` +
      `cadence=${row.digestCadence} enabled=${row.digestEnabled}`,
  );
}

function describePlace(p: HomeCandidate): string {
  const where = [p.name, p.regionName ?? p.regionCode, p.countryCode].filter(Boolean).join(", ");
  return `${where} (geonames ${p.geonamesId}, ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}, pop ${p.population})`;
}

await runScript("user-set-prefs", main);
