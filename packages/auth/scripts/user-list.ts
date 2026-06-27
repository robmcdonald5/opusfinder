import { eq } from "drizzle-orm";

import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { user, userPreferences, userProfiles } from "@opusfinder/db/schema";
import { runScript } from "@opusfinder/shared/script";

import { maskEmail } from "./cli-utils";

// pnpm user:list — one line per user: masked email, verified, approved (the send permit), cadence, enabled,
// has-profile, id. db-only (no auth/secret needed). Emails are masked (PII discipline); the id is the join key.
async function main(): Promise<void> {
  const db = createDb(getDatabaseUrl());
  const rows = await db
    .select({
      id: user.id,
      email: user.email,
      verified: user.emailVerified,
      // The DB-native send permit — NULL = un-approved = fail-closed (no send).
      approvedAt: userPreferences.digestApprovedAt,
      cadence: userPreferences.digestCadence,
      enabled: userPreferences.digestEnabled,
      profileId: userProfiles.id,
    })
    .from(user)
    .leftJoin(userPreferences, eq(userPreferences.userId, user.id))
    .leftJoin(userProfiles, eq(userProfiles.userId, user.id))
    .orderBy(user.createdAt);

  if (rows.length === 0) {
    console.log("(no users)");
    return;
  }
  console.log(`${rows.length} user(s):`);
  for (const row of rows) {
    console.log(
      `  ${maskEmail(row.email)}  verified=${row.verified}  approved=${row.approvedAt !== null}  ` +
        `cadence=${row.cadence ?? "—"}  enabled=${row.enabled ?? "—"}  profile=${row.profileId !== null}  id=${row.id}`,
    );
  }
}

await runScript("user-list", main);
