import { parseArgs } from "node:util";

import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { setDigestApproval } from "@opusfinder/db/repos";
import { runScript } from "@opusfinder/shared/script";

import { findUserByEmail } from "../src/index";
import { maskEmail } from "./cli-utils";

// pnpm user:approve --email <email> [--revoke]
// The operator SEND PERMIT (migration 0022) — grants (or with --revoke clears) `digest_approved_at`, the
// DB-native gate that replaces the env-var EMAIL_ALLOWLIST. Granting is a single write effective on the next
// cadence tick (no redeploy). Onboarding a friend: user:create → ingest-cv → user:set-prefs → user:approve.
// db-only (no auth/secret needed — like user:list); emails are masked (PII discipline).
const USAGE = "Usage: pnpm user:approve --email <email> [--revoke]";

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      email: { type: "string" },
      revoke: { type: "boolean" },
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

  const approved = !values.revoke;
  const row = await setDigestApproval(db, userId, approved);
  const verb = approved ? "approved" : "revoked approval for";
  console.log(`${verb} ${maskEmail(email)} (${userId})`);
  console.log(`  digest_approved_at=${row.digestApprovedAt?.toISOString() ?? "—"}`);
}

await runScript("user-approve", main);
