import { parseArgs } from "node:util";

import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { updatePreferences } from "@opusfinder/db/repos";
import { runScript } from "@opusfinder/shared/script";

import { findUserByEmail } from "../src/index";
import { maskEmail, prefsFromFlags } from "./cli-utils";

const USAGE =
  "Usage: pnpm user:set-prefs --email <email> [--remote true|false] [--locations a,b] [--min-salary 120000] " +
  "[--recency-days 14] [--cadence daily|weekly|monthly] [--enabled true|false]";

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      email: { type: "string" },
      remote: { type: "string" },
      locations: { type: "string" },
      "min-salary": { type: "string" },
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
  const userId = await findUserByEmail(db, email);
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
  console.log(
    `  remote_ok=${row.remoteOk} locations=[${row.locations.join(",")}] min_salary=${row.minSalary ?? "—"} ` +
      `recency_days=${row.recencyDays} cadence=${row.digestCadence} enabled=${row.digestEnabled}`,
  );
}

await runScript("user-set-prefs", main);
