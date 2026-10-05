import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import { gatherHealthSignals } from "@opusfinder/db/health";
import { sourceRuns } from "@opusfinder/db/schema";

import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";

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

  it("reads 0 / 0 from a run row written before the counters existed", async () => {
    await db.insert(sourceRuns).values({ pipeline: "ingestion", status: "ok", counts: { jobs: 5 } });

    const signals = await gatherHealthSignals(db);

    expect(signals.latestIngestHydrateSkipped).toBe(0);
    expect(signals.latestIngestHydrateListed).toBe(0);
  });
});
