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
      // The DB-native send permit (migration 0022) — NULL = un-approved = fail-closed (no send). The read-side
      // counterpart to `pnpm user:approve`, so the roster can audit who the cadence sweep will actually email.
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
  for (const r of rows) {
    console.log(
      `  ${maskEmail(r.email)}  verified=${r.verified}  approved=${r.approvedAt !== null}  ` +
        `cadence=${r.cadence ?? "—"}  enabled=${r.enabled ?? "—"}  profile=${r.profileId !== null}  id=${r.id}`,
    );
  }
}

await runScript("user-list", main);
