/**
 * LIVE gate (opt-in) — `getDigestEmailPayload` over the REAL neon-http driver. This is the one seam the
 * PGlite integration suite (digests.integration.test.ts, which owns the COALESCE/LEFT-join/active-filter
 * SEMANTICS) cannot cover: driver TYPE-MAPPING parity. The retired `scripts/test-digest-payload.ts` was
 * the only path exercising this repo read through neon-http on real data (VITEST_MIGRATION_PLAN §10.1
 * "known loss"); this gate replaces it. It proves neon-http returns the SAME JS types PGlite does —
 * `jsonb` → real `string[]`, `boolean` → `boolean`, `int` → `number` across BOTH the digest_items
 * snapshot leg AND the live jobs/companies COALESCE-fallback leg, plus `timestamptz` → `Date` on the
 * header columns (createdAt / approvedAt — the only Date fields DigestEmailPayload projects).
 *
 * Self-seeding: inserts a minimal digest graph (user → preferences → run → digest → items, + company +
 * jobs) with run-unique ids, asserts, then deletes ONLY the rows it created (child→parent, no TRUNCATE —
 * this runs against a real/branched database, never a throwaway PGlite). neon-http is stateless (no
 * pool/socket), so there is nothing to close.
 *
 * LIVES IN THE `live` VITEST PROJECT (`*.live.test.ts`, no MSW) — NOT `integration`: MSW 2.x intercepts
 * the neon-http `fetch`, which would hard-fail under the integration project's onUnhandledRequest:"error".
 *
 * NEVER runs in CI's secret-free lane: gated on an EXPLICIT opt-in flag (DIGEST_LIVE_TEST=1) ON TOP of
 * DATABASE_URL, so it SKIPS on every dev box and in `pnpm test` even when a package .env defines the URL.
 * The top-level imports are side-effect-free (lazy env getters) so the file loads — and skips — creds-free.
 *
 *   DIGEST_LIVE_TEST=1 pnpm test:live
 */
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createDb, type Db } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import {
  getDigestEmailPayload,
  insertDigest,
  insertDigestItems,
  startDigestRun,
  type NewDigestItem,
} from "@opusfinder/db/repos";
import { companies, digestItems, digestRuns, digests, jobs, user, userPreferences } from "@opusfinder/db/schema";
import { companySlug, jobId, type UserId } from "@opusfinder/shared";

const LIVE = process.env.DIGEST_LIVE_TEST === "1" && !!process.env.DATABASE_URL;

describe.skipIf(!LIVE)("getDigestEmailPayload over neon-http (live: real Neon)", () => {
  let db: Db | undefined;
  // Captured as they are created so teardown removes ONLY this gate's rows even after a partial seed.
  let userId: UserId | undefined;
  let runId: number | undefined;
  let digestId: number | undefined;
  let companyId: number | undefined;
  const jobIds: number[] = [];

  afterAll(async () => {
    if (!db) return;
    // Child → parent. digest_items.job_id has NO FK to jobs (a plain historical reference — the
    // constraint was dropped), so its rows are cleared here for cleanliness; digests.digest_run_id IS a
    // NO ACTION FK, so the digest must go before its run. Delete by captured id — never TRUNCATE a real DB.
    if (digestId !== undefined) {
      await db.delete(digestItems).where(eq(digestItems.digestId, digestId));
      await db.delete(digests).where(eq(digests.id, digestId));
    }
    if (runId !== undefined) await db.delete(digestRuns).where(eq(digestRuns.id, runId));
    for (const id of jobIds) await db.delete(jobs).where(eq(jobs.id, id));
    if (companyId !== undefined) await db.delete(companies).where(eq(companies.id, companyId));
    if (userId !== undefined) {
      await db.delete(userPreferences).where(eq(userPreferences.userId, userId));
      await db.delete(user).where(eq(user.id, userId));
    }
  });

  it("maps neon-http result types identically to PGlite (jsonb → string[], boolean, timestamptz → Date)", async () => {
    db = createDb(getDatabaseUrl());
    const tag = crypto.randomUUID();
    userId = crypto.randomUUID() as UserId;

    await db.insert(user).values({
      id: userId,
      name: "Live Test User",
      email: `livetest-${tag}@example.invalid`,
      emailVerified: true,
    });
    const approvedAt = new Date();
    await db.insert(userPreferences).values({
      userId,
      unsubscribeToken: `live-${tag}`,
      digestEnabled: true,
      digestCadence: "daily",
      digestApprovedAt: approvedAt,
      digestSuppressedAt: null,
      digestBounceStatus: "none",
      lastDigestSentAt: null,
      lastDigestEmailId: null,
    });

    const slug = companySlug(`livetest-${tag.slice(0, 8)}`);
    const companyRows = await db
      .insert(companies)
      .values({ slug, source: "greenhouse" })
      .returning({ id: companies.id });
    companyId = companyRows[0]!.id;

    // jSnap's item renders from the digest_items SNAPSHOT (jsonb digest_items.locations); jLive's item
    // renders from the LIVE jobs row (jsonb jobs.locations) via COALESCE fallback — both jsonb→string[].
    const jSnap = await seedJob("snap", "Live Snap Job", ["Liveville"], false, "https://live/snap");
    const jLive = await seedJob("live", "Live Fallback Job", ["Berlin", "Remote - EU"], true, "https://live/fallback");

    runId = await startDigestRun(db, "manual");
    ({ id: digestId } = await insertDigest(db, { userId, digestRunId: runId, itemCount: 2, counts: {} }));

    // Item 1 — full snapshot (renders from digest_items.*).
    const snapItem: NewDigestItem = {
      jobId: jSnap,
      rank: 1,
      score: 0.5,
      reason: "snapshot item",
      jobTitle: "Snap Title",
      companySlug: "snap-co",
      applyUrl: "https://snap",
      locations: ["Remote - US", "NYC"],
      remote: true,
    };
    await insertDigestItems(db, digestId, userId, [snapItem]);
    // Item 2 — NULL snapshot (insertDigestItems cannot write NULLs, so seed directly) → forces COALESCE
    // onto the live jobs/companies leg.
    await db
      .insert(digestItems)
      .values({ digestId, userId, jobId: jLive, rank: 2, score: 0.25, reason: "live item" });

    const payload = await getDigestEmailPayload(db, digestId);
    expect(payload).not.toBeNull();

    // Timestamps: neon-http maps timestamptz → Date (the PGlite parity this gate exists to prove).
    expect(payload!.createdAt).toBeInstanceOf(Date);
    expect(payload!.approvedAt).toBeInstanceOf(Date);
    expect(payload!.approvedAt!.getTime()).toBe(approvedAt.getTime());
    expect(payload!.recipient).toEqual({ email: `livetest-${tag}@example.invalid`, name: "Live Test User" });
    expect(payload!.userId).toBe(userId);
    expect(payload!.digestId).toBe(digestId);

    // Both items active → both present, ordered by rank.
    expect(payload!.items).toHaveLength(2);
    expect(payload!.items.map((i) => i.rank)).toEqual([1, 2]);

    // Snapshot leg (digest_items jsonb + text).
    expect(payload!.items[0]).toEqual({
      rank: 1,
      reason: "snapshot item",
      title: "Snap Title",
      companySlug: "snap-co",
      applyUrl: "https://snap",
      locations: ["Remote - US", "NYC"],
      remote: true,
    });
    // Live-fallback leg (jobs jsonb + companies text via COALESCE).
    expect(payload!.items[1]).toEqual({
      rank: 2,
      reason: "live item",
      title: "Live Fallback Job",
      companySlug: slug,
      applyUrl: "https://live/fallback",
      locations: ["Berlin", "Remote - EU"],
      remote: true,
    });

    // Explicit driver-mapping assertions over BOTH legs — a stringified array or a "t"/"f" string would
    // fail these where a shallow value check might not.
    for (const item of payload!.items) {
      expect(typeof item.rank).toBe("number");
      expect(typeof item.remote).toBe("boolean");
      expect(Array.isArray(item.locations)).toBe(true);
      expect(item.locations.every((l) => typeof l === "string")).toBe(true);
      expect(typeof item.title).toBe("string");
      expect(typeof item.applyUrl).toBe("string");
    }
  });

  // jobs.(source, external_id) is UNIQUE — a per-job crypto suffix keeps each seed row from colliding
  // with a prior run's leftovers if a teardown ever failed. Pushes the new id for teardown.
  async function seedJob(
    suffix: string,
    title: string,
    locations: string[],
    remote: boolean,
    applyUrl: string,
  ): Promise<number> {
    const rows = await db!
      .insert(jobs)
      .values({
        externalId: jobId(`live-${suffix}-${crypto.randomUUID()}`),
        companyId: companyId!,
        source: "greenhouse",
        title,
        descriptionText: "body",
        locations,
        remote,
        applyUrl,
      })
      .returning({ id: jobs.id });
    const id = rows[0]!.id;
    jobIds.push(id);
    return id;
  }
});
