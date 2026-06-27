import { parseArgs } from "node:util";

import { desc, eq } from "drizzle-orm";

import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";
import { digests, userPreferences } from "../src/schema";

/**
 * The delivery checks as a runnable script: the newest digest's per-send state (`email_id` /
 * `delivery_status` / `sent_at`) + the owner row's user-level delivery state. Shape-only output — the
 * recipient address is never echoed (the Resend email id is an opaque, non-sensitive handle and IS
 * printed for dashboard cross-reference).
 *
 *   pnpm --filter @opusfinder/db delivery [--digest <id>]   (default: newest digest)
 */
await runScript("show-digest-delivery", async () => {
  const { values } = parseArgs({ options: { digest: { type: "string" } } });

  let digestId: number | undefined;
  if (values.digest !== undefined) {
    digestId = Number(values.digest);
    if (!Number.isInteger(digestId) || digestId <= 0) {
      throw new Error(`--digest expects a positive integer, got "${values.digest}"`);
    }
  }

  const db = createDb(getDatabaseUrl());

  const header = await db
    .select({
      id: digests.id,
      userId: digests.userId,
      itemCount: digests.itemCount,
      emailId: digests.emailId,
      deliveryStatus: digests.deliveryStatus,
      sentAt: digests.sentAt,
      createdAt: digests.createdAt,
    })
    .from(digests)
    .where(digestId !== undefined ? eq(digests.id, digestId) : undefined)
    .orderBy(desc(digests.id))
    .limit(1);
  const digestRow = header[0];
  if (!digestRow) {
    console.log("(no digests rows)");
    return;
  }

  console.log(
    `digest #${digestRow.id}: items=${digestRow.itemCount} delivery_status=${digestRow.deliveryStatus} ` +
      `email_id=${digestRow.emailId ?? "(null)"} sent_at=${formatTs(digestRow.sentAt)} ` +
      `created_at=${formatTs(digestRow.createdAt)}`,
  );

  const prefs = await db
    .select({
      lastDigestSentAt: userPreferences.lastDigestSentAt,
      lastDigestEmailId: userPreferences.lastDigestEmailId,
      digestBounceStatus: userPreferences.digestBounceStatus,
      digestSuppressedAt: userPreferences.digestSuppressedAt,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, digestRow.userId))
    .limit(1);
  const prefsRow = prefs[0];
  if (!prefsRow) {
    console.log("(no user_preferences row for the digest's user — eligibility invariant broken)");
    return;
  }
  console.log(
    `user prefs: last_digest_sent_at=${formatTs(prefsRow.lastDigestSentAt)} ` +
      `last_digest_email_id=${prefsRow.lastDigestEmailId ?? "(null)"} ` +
      `bounce_status=${prefsRow.digestBounceStatus} suppressed_at=${formatTs(prefsRow.digestSuppressedAt)}`,
  );
});

/** ISO timestamp for a Date column value; "(null)" for a NULL. */
function formatTs(value: Date | null): string {
  return value === null ? "(null)" : value.toISOString();
}
