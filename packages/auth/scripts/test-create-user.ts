import { eq } from "drizzle-orm";

import { createDb } from "@opusfinder/db";
import { createAuthDb } from "@opusfinder/db/auth-client";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { account, user, userPreferences } from "@opusfinder/db/schema";
import { generateUnsubscribeToken } from "@opusfinder/shared";
import { runScript } from "@opusfinder/shared/script";

import { getAuthBaseURL, getAuthSecret } from "../src/env";
import { createAuth, createUserWithPreferences, getOrCreateUserByEmail } from "../src/index";

// The FULL user-creation path end to end against Neon: signUpEmail → emailVerified flip →
// user_preferences seed; then idempotency via getOrCreateUserByEmail. Self-cleaning (deletes the
// throwaway user, cascade-removing account/session/prefs) so it leaves no trace and can re-run.
// Run: pnpm --filter @opusfinder/auth test:create-user  (needs DATABASE_URL + BETTER_AUTH_SECRET)
const EMAIL = "phase95-create-smoke@example.com";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const db = createDb(getDatabaseUrl());
  const authDb = createAuthDb(getDatabaseUrl());
  const auth = createAuth(authDb, { secret: getAuthSecret(), baseURL: getAuthBaseURL() });
  try {
    // Clean any leftover from an interrupted prior run (cascade removes account/prefs/session).
    await db.delete(user).where(eq(user.email, EMAIL));

    const { userId } = await createUserWithPreferences(db, auth, {
      email: EMAIL,
      password: generateUnsubscribeToken(),
      name: "Smoke",
      markVerified: true,
      prefs: { locationMode: "onsite_only", recencyDays: 7, digestCadence: "daily" },
    });
    check("returns a userId", typeof userId === "string" && userId.length > 0, String(userId));

    const userRow = (await db.select().from(user).where(eq(user.id, userId)).limit(1))[0];
    check("user row created", !!userRow);
    check("email stored", userRow?.email === EMAIL, userRow?.email);
    check("emailVerified flipped true", userRow?.emailVerified === true);

    const acct = (await db.select().from(account).where(eq(account.userId, userId)).limit(1))[0];
    check("account row exists (credential)", acct?.providerId === "credential", acct?.providerId);
    check("password hash present", typeof acct?.password === "string" && acct.password.length > 0);

    const prefs = (
      await db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1)
    )[0];
    check("preferences row created", !!prefs);
    check("unsubscribe_token (64-hex) set", /^[0-9a-f]{64}$/.test(prefs?.unsubscribeToken ?? ""));
    check("override applied: locationMode=onsite_only", prefs?.locationMode === "onsite_only");
    check("override applied: recencyDays=7", prefs?.recencyDays === 7);
    check("override applied: cadence=daily", prefs?.digestCadence === "daily");
    check("default kept: digestEnabled=true", prefs?.digestEnabled === true);
    check(
      "default kept: locations=[]",
      Array.isArray(prefs?.locations) && prefs?.locations.length === 0,
    );

    // Idempotency: same email resolves to the same user, no duplicate, no throw.
    const again = await getOrCreateUserByEmail(db, auth, ` ${EMAIL.toUpperCase()} `);
    check(
      "getOrCreateUserByEmail idempotent (case/space-insensitive)",
      again.userId === userId,
      again.userId,
    );
    const dupes = await db.select({ id: user.id }).from(user).where(eq(user.email, EMAIL));
    check("no duplicate user", dupes.length === 1, `count ${dupes.length}`);

    // Cleanup — cascade removes account/session/prefs.
    await db.delete(user).where(eq(user.id, userId));
    const remaining = await db.select({ id: user.id }).from(user).where(eq(user.id, userId));
    const prefsRemaining = await db
      .select({ id: userPreferences.id })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId));
    check("cleanup removed user", remaining.length === 0);
    check("cleanup cascaded to preferences", prefsRemaining.length === 0);

    if (failures === 0) {
      console.log("\nPASS: 9.5d user-creation path verified end to end (and cleaned up).");
      return;
    }
    console.error(`\nFAIL: ${failures} check(s) failed.`);
    process.exitCode = 1;
  } finally {
    await authDb.$client.end();
  }
}

await runScript("test-create-user", main);
