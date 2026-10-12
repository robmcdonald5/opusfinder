import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import { gatherHealthSignals } from "@opusfinder/db/health";
import { upsertCompany, upsertJobs } from "@opusfinder/db/repos";
import { companies, jobs, sourceRuns } from "@opusfinder/db/schema";
import { companySlug, jobId, type NormalizedJob } from "@opusfinder/shared";

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
