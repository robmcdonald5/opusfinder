import { parseArgs } from "node:util";

import { createDb } from "@opusfinder/db";
import { createAuthDb } from "@opusfinder/db/auth-client";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { runScript } from "@opusfinder/shared/script";

import { getAuthBaseURL, getAuthSecret } from "../src/env";
import { createAuth, createUserWithPreferences } from "../src/index";
import { maskEmail, prefsFromFlags } from "./cli-utils";

const USAGE =
  "Usage: pnpm user:create --email <email> --password <pw> [--name <name>] " +
  "[--location-mode any|remote_only|onsite_only] [--locations a,b] [--min-salary N] [--max-salary N] " +
  "[--min-yoe N] [--max-yoe N] [--dealbreakers a,b] [--exclusions a,b] " +
  "[--recency-days 14] [--cadence daily|weekly|monthly] [--enabled true|false]";

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      email: { type: "string" },
      password: { type: "string" },
      name: { type: "string" },
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
  const password = values.password;
  if (!email || !password) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (password.length < 8) {
    console.error("--password must be at least 8 characters.");
    process.exitCode = 1;
    return;
  }

  const db = createDb(getDatabaseUrl());
  const authDb = createAuthDb(getDatabaseUrl());
  const auth = createAuth(authDb, { secret: getAuthSecret(), baseURL: getAuthBaseURL() });
  try {
    const prefs = prefsFromFlags(values);
    const { userId } = await createUserWithPreferences(db, auth, {
      email,
      password,
      name: values.name,
      markVerified: true,
      prefs,
    });
    // No secrets in output: the email is masked and the password is never echoed. Echo only WHICH prefs
    // were overridden, not their values — dealbreakers/exclusions are free text that may carry company
    // names (PII); keys-only keeps the echo uniform and safe.
    console.log(`created verified user ${maskEmail(email)}`);
    console.log(`  user_id: ${userId}`);
    console.log(
      `  prefs overrides: ${Object.keys(prefs).length > 0 ? Object.keys(prefs).join(", ") : "(defaults)"}`,
    );
  } finally {
    await authDb.$client.end();
  }
}

await runScript("user-create", main);
