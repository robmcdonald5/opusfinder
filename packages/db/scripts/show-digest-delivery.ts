import { parseArgs } from "node:util";

import { desc, eq } from "drizzle-orm";

import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";
import { digests, userPreferences } from "../src/schema";

/**
 * The Phase-11 live-gate delivery checks as a runnable script (spec §10's two SQL gates): the
 * newest digest's per-send state (`email_id` / `delivery_status` / `sent_at`) + the owner row's
 * user-level delivery state. Shape-only output — the recipient address is never echoed (the Resend
 * email id is an opaque, non-sensitive handle and IS printed for dashboard cross-reference).
 *
 *   pnpm --filter @opusfinder/db delivery [--digest <id>]   (default: newest digest)
 */
await runScript("show-digest-delivery", async () => {
  const { values } = parseArgs({ options: { digest: { type: "string" } } });
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
    .where(values.digest !== undefined ? eq(digests.id, Number(values.digest)) : undefined)
    .orderBy(desc(digests.id))
    .limit(1);
  const d = header[0];
  if (!d) {
    console.log("(no digests rows)");
    return;
  }

  console.log(
    `digest #${d.id}: items=${d.itemCount} delivery_status=${d.deliveryStatus} ` +
      `email_id=${d.emailId ?? "(null)"} sent_at=${d.sentAt?.toISOString() ?? "(null)"} ` +
      `created_at=${d.createdAt.toISOString()}`,
  );

  const prefs = await db
    .select({
      lastDigestSentAt: userPreferences.lastDigestSentAt,
      lastDigestEmailId: userPreferences.lastDigestEmailId,
      digestBounceStatus: userPreferences.digestBounceStatus,
      digestSuppressedAt: userPreferences.digestSuppressedAt,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, d.userId))
    .limit(1);
  const p = prefs[0];
  if (!p) {
    console.log("(no user_preferences row for the digest's user — eligibility invariant broken)");
    return;
  }
  console.log(
    `user prefs: last_digest_sent_at=${p.lastDigestSentAt?.toISOString() ?? "(null)"} ` +
      `last_digest_email_id=${p.lastDigestEmailId ?? "(null)"} ` +
      `bounce_status=${p.digestBounceStatus} suppressed_at=${p.digestSuppressedAt?.toISOString() ?? "(null)"}`,
  );
});
