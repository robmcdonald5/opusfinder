import { parseArgs } from "node:util";

import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { updatePreferences } from "@opusfinder/db/repos";
import { runScript } from "@opusfinder/shared/script";

import { findUserIdByEmail } from "../src/index";
import { maskEmail, prefsFromFlags } from "./cli-utils";

const USAGE =
  "Usage: pnpm user:set-prefs --email <email> [--location-mode any|remote_only|onsite_only] [--locations a,b] " +
  "[--min-salary N|clear] [--max-salary N|clear] [--min-yoe N|clear] [--max-yoe N|clear] " +
  "[--dealbreakers a,b] [--exclusions a,b] [--recency-days 14] [--cadence daily|weekly|monthly] [--enabled true|false]";

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      email: { type: "string" },
      "location-mode": { type: "string" },
      locations: { type: "string" },
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
  if (Object.keys(patch).length === 0) {
    console.error("No preference flags provided — nothing to update.");
    process.exitCode = 1;
    return;
  }

  const row = await updatePreferences(db, userId, patch);
  console.log(`updated prefs for ${maskEmail(email)} (${userId})`);
  // Free-text arrays (dealbreakers/exclusions) may carry company names — echo COUNTS, not contents (PII).
  console.log(
    `  location_mode=${row.locationMode} locations=[${row.locations.join(",")}] ` +
      `salary=[${row.minSalary ?? "—"}..${row.maxSalary ?? "—"}] yoe=[${row.yoeMin ?? "—"}..${row.yoeMax ?? "—"}] ` +
      `recency_days=${row.recencyDays} ` +
      `dealbreakers=${row.dealbreakers.length} exclusions=${row.exclusions.length} ` +
      `cadence=${row.digestCadence} enabled=${row.digestEnabled}`,
  );
}

await runScript("user-set-prefs", main);
