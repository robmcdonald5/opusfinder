import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import { gatherHealthSignals } from "@opusfinder/db/health";
import { upsertCompany, upsertJobs } from "@opusfinder/db/repos";
import {
  companies,
  digestRuns,
  digests,
  jobs,
  sourceRuns,
  user,
  userPreferences,
  type DigestBounceStatus,
  type DigestDeliveryStatus,
} from "@opusfinder/db/schema";
import { companySlug, jobId, type NormalizedJob } from "@opusfinder/shared";

import { uid } from "@test/db/ids";
import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";
import { oneHot } from "@test/db/vectors";

// The hydrate_skip_ratio inputs are read from the LATEST ingestion run's `counts` jsonb by KEY NAME. The
// pure evaluator suite (health.test.ts) feeds canned signals, so it can't see a key that drifted from the
// counter runIngestion actually writes (`hydrateSkipped` / `hydrateListed`) — a drift would silently read 0
// and the check would never fire. This pins the SQL against real Postgres.
describe("gatherHealthSignals — hydrate_skip_ratio inputs (integration: real PGlite)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    await truncate(db, sourceRuns);
  });
  afterAll(async () => {
    await close?.();
  });

  it("reads hydrateSkipped / hydrateListed from the LATEST ingestion run's counts", async () => {
    await db.insert(sourceRuns).values([
      {
        pipeline: "ingestion",
        status: "ok",
        startedAt: new Date("2026-10-01T10:00:00Z"),
        counts: { hydrateSkipped: 99, hydrateListed: 100 },
      },
      {
        pipeline: "ingestion",
        status: "ok",
        startedAt: new Date("2026-10-01T12:00:00Z"),
        counts: { hydrateSkipped: 7, hydrateListed: 140 },
      },
    ]);

    const signals = await gatherHealthSignals(db);

    expect(signals.latestIngestHydrateSkipped).toBe(7);
    expect(signals.latestIngestHydrateListed).toBe(140);
  });

  it("skips a still-RUNNING tick (its counts are the {} default) and reads the latest finished run", async () => {
    // The health cron fires at :10, inside an ingestion tick that runs long: the newest row is in flight.
    await db.insert(sourceRuns).values([
      {
        pipeline: "ingestion",
        status: "ok",
        startedAt: new Date("2026-10-01T10:00:00Z"),
        counts: {
          failed: 3,
          rateLimitSkipped: 1,
          processed: 4,
          companies: 4,
          hydrateSkipped: 30,
          hydrateListed: 60,
        },
      },
      { pipeline: "ingestion", status: "running", startedAt: new Date("2026-10-01T12:00:00Z") },
    ]);

    const signals = await gatherHealthSignals(db);

    expect(signals.latestIngestStatus).toBe("ok");
    expect(signals.latestIngestFailed).toBe(3);
    expect(signals.latestIngestRateLimitSkipped).toBe(1);
    expect(signals.latestIngestHydrateSkipped).toBe(30);
    expect(signals.latestIngestHydrateListed).toBe(60);
  });

  it("reads 0 / 0 from a run row written before the counters existed", async () => {
    await db.insert(sourceRuns).values({ pipeline: "ingestion", status: "ok", counts: { jobs: 5 } });

    const signals = await gatherHealthSignals(db);

    expect(signals.latestIngestHydrateSkipped).toBe(0);
    expect(signals.latestIngestHydrateListed).toBe(0);
    expect(signals.latestIngestRateLimitSkipped).toBe(0);
  });
});

describe("gatherHealthSignals — embedding_backlog (integration: real PGlite)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => {
    await close?.();
  });

  it("counts only the active, embeddable jobs still owed a vector — the drain's own work", async () => {
    const job = (externalId: string, title: string, descriptionText = "body"): NormalizedJob => ({
      source: "greenhouse",
      externalId: jobId(externalId),
      title,
      companySlug: companySlug("acme"),
      locations: [],
      remote: true,
      descriptionText,
      applyUrl: `https://example.test/${externalId}`,
      postedAt: null,
    });
    await truncate(db, companies, jobs);
    const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
    await upsertJobs(db, companyId, [
      job("owed", "Owed Role"),
      job("closed", "Closed Role"),
      job("embedded", "Embedded Role"),
      job("blank", " ", ""),
    ]);
    await db
      .update(jobs)
      .set({ lifecycleState: "closed" })
      .where(eq(jobs.externalId, jobId("closed")));
    await db
      .update(jobs)
      .set({ embedding: oneHot(0) })
      .where(eq(jobs.externalId, jobId("embedded")));

    expect((await gatherHealthSignals(db)).embeddingBacklog).toBe(1);
  });
});

// Every other read is pinned here too: num() turns a mis-aliased column or a drifted counts key into 0, which
// reads healthy, and the pure suite (health.test.ts) can't see that.
describe("gatherHealthSignals — run ages, lane errors, digest windows, cost rollup (integration: real PGlite)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
  const daysAgo = (d: number) => hoursAgo(d * 24);

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    await truncate(db, sourceRuns, digests, digestRuns, userPreferences, user);
  });
  afterAll(async () => {
    await close?.();
  });

  async function seedUser(
    n: number,
    prefs: { suppressedAt?: Date; bounce?: DigestBounceStatus } = {},
  ) {
    const userId = uid(n);
    await db.insert(user).values({ id: userId, name: `User ${n}`, email: `user${n}@test.local` });
    await db.insert(userPreferences).values({
      userId,
      unsubscribeToken: `tok-${n}`,
      digestSuppressedAt: prefs.suppressedAt ?? null,
      digestBounceStatus: prefs.bounce ?? "none",
    });
  }

  async function seedDigestRun(status: "ok" | "error", startedAt: Date): Promise<number> {
    const rows = await db
      .insert(digestRuns)
      .values({ trigger: "cron", status, startedAt })
      .returning({ id: digestRuns.id });
    return rows[0]!.id;
  }

  async function seedDigest(
    userN: number,
    digestRunId: number,
    deliveryStatus: DigestDeliveryStatus,
    extra: { createdAt?: Date; counts?: Record<string, number> } = {},
  ) {
    await db.insert(digests).values({
      userId: uid(userN),
      digestRunId,
      deliveryStatus,
      counts: extra.counts ?? {},
      createdAt: extra.createdAt ?? new Date(),
    });
  }

  it("reads null ages and zero counts from an empty database", async () => {
    const signals = await gatherHealthSignals(db);

    expect(signals).toMatchObject({
      ingestionAgeH: null,
      discoveryAgeD: null,
      discoveryLaneErrors: 0,
      digestErrors: 0,
      suppressed: 0,
      cost: { digestsConsidered: 0, rerankCacheReadTokens: 0, rerankCacheCreationTokens: 0 },
    });
  });

  it("reads ages off the last ok run's finish, and discovery off the all-source sweep only", async () => {
    await db.insert(sourceRuns).values([
      { pipeline: "ingestion", status: "ok", startedAt: hoursAgo(3.5), finishedAt: hoursAgo(3) },
      { pipeline: "ingestion", status: "error", startedAt: hoursAgo(1.5), finishedAt: hoursAgo(1) },
      {
        pipeline: "discovery",
        status: "ok",
        startedAt: daysAgo(10),
        finishedAt: daysAgo(10),
        counts: { lane_hn_error: 2, lane_crtsh_error: 1, lane_hn_candidates: 40 },
      },
      // A manual `pnpm discover --source=X` run: fresh, but it says nothing about the weekly sweep.
      {
        pipeline: "discovery",
        source: "greenhouse",
        status: "ok",
        startedAt: daysAgo(1),
        finishedAt: daysAgo(1),
        counts: { lane_hn_error: 9 },
      },
    ]);

    const signals = await gatherHealthSignals(db);

    expect(signals.ingestionAgeH).toBeCloseTo(3, 2);
    expect(signals.discoveryAgeD).toBeCloseTo(10, 2);
    expect(signals.discoveryLaneErrors).toBe(3);
  });

  it("counts errored runs and failed sends from the last 7 days of runs, within the last N runs", async () => {
    for (const n of [1, 2, 3]) await seedUser(n);
    await seedDigestRun("error", daysAgo(10)); // aged out
    await seedDigest(1, await seedDigestRun("ok", daysAgo(9)), "failed"); // aged out with its run
    await seedDigestRun("error", daysAgo(2));
    // The orchestrator finishes its run 'ok' at fan-out, so a user's failed send shows only on digests.
    const recentOk = await seedDigestRun("ok", daysAgo(1));
    await seedDigest(1, recentOk, "failed");
    await seedDigest(2, recentOk, "failed");
    await seedDigest(3, recentOk, "sent");

    expect((await gatherHealthSignals(db)).digestErrors).toBe(3);
    expect((await gatherHealthSignals(db, { digestWindowN: 1 })).digestErrors).toBe(2);
  });

  it("counts each user suppressed in the last 7 days once, whether by hard bounce or complaint", async () => {
    // A hard bounce stamps both columns; it must not count twice.
    await seedUser(1, { suppressedAt: daysAgo(1), bounce: "hard" });
    await seedUser(2, { suppressedAt: daysAgo(2) }); // spam complaint: suppressed, no bounce
    await seedUser(3, { suppressedAt: daysAgo(30), bounce: "hard" }); // aged out
    await seedUser(4);

    expect((await gatherHealthSignals(db)).suppressed).toBe(2);
  });

  it("sums the named rerank-cache keys over the latest N digests", async () => {
    await seedUser(1);
    await seedDigest(1, await seedDigestRun("ok", daysAgo(2)), "sent", {
      createdAt: daysAgo(2),
      counts: { rerankCacheReadTokens: 1000, rerankCacheCreationTokens: 50 },
    });
    await seedDigest(1, await seedDigestRun("ok", daysAgo(1)), "sent", {
      createdAt: daysAgo(1),
      counts: { rerankCacheReadTokens: 900, rerankCacheCreationTokens: 100, retrieved: 40 },
    });

    expect((await gatherHealthSignals(db)).cost).toEqual({
      digestsConsidered: 2,
      rerankCacheReadTokens: 1900,
      rerankCacheCreationTokens: 150,
    });
    expect((await gatherHealthSignals(db, { costRollupN: 1 })).cost).toEqual({
      digestsConsidered: 1,
      rerankCacheReadTokens: 900,
      rerankCacheCreationTokens: 100,
    });
  });
});
