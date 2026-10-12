import { eq, sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import { companies, jobs } from "@opusfinder/db/schema";
import { companySlug, jobId, type NormalizedJob } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";

import { upsertCompany, upsertJobs } from "./jobs";
import { sweepLifecycle, sweepStaleJobs } from "./lifecycle";

// The lifecycle writers' row semantics on real Postgres, where the clocks they set and read interact
// (lifecycle.test.ts covers the emitted SQL shape only).

function job(externalId: string): NormalizedJob {
  return {
    source: "greenhouse",
    externalId: jobId(externalId),
    title: `Engineer ${externalId}`,
    companySlug: companySlug("acme"),
    locations: [],
    remote: false,
    descriptionText: `body ${externalId}`,
    applyUrl: `https://example.test/${externalId}`,
    postedAt: null,
  };
}

describe("lifecycle writers — clock semantics (integration: real PGlite Postgres)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    await truncate(db, companies, jobs);
  });
  afterAll(async () => {
    await close?.();
  });

  async function seedBoard(ids: string[], lastIngestedAt: SQL): Promise<number> {
    const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
    await upsertJobs(db, companyId, ids.map(job));
    await db.update(companies).set({ lastIngestedAt }).where(eq(companies.id, companyId));
    return companyId;
  }

  async function jobRow(externalId: string) {
    const rows = await db
      .select()
      .from(jobs)
      .where(eq(jobs.externalId, jobId(externalId)));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it("sweepLifecycle stamps last_seen_at on a row it revives, so the same tick's stale sweep can't re-close it", async () => {
    const companyId = await seedBoard(["back", "gone"], sql`now() - interval '1 day'`);
    // Both 30 days unseen; "back" was closed and is listed again, "gone" is still active and absent.
    await db.update(jobs).set({ lastSeenAt: sql`now() - interval '30 days'` });
    await db
      .update(jobs)
      .set({ lifecycleState: "closed", closedAt: sql`now() - interval '9 days'` })
      .where(eq(jobs.externalId, jobId("back")));
    const goneSeenBefore = (await jobRow("gone")).lastSeenAt;

    // markJobsPresent failed this tick (never called), so the sweep is the only revive.
    const sweep = await sweepLifecycle(db, companyId, ["back"], { enforce: true });
    expect(sweep.revived).toBe(1);
    const back = await jobRow("back");
    expect(back.lifecycleState).toBe("active");
    expect(back.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // An absent row's clock is untouched — it keeps ageing toward the stale close.
    expect((await jobRow("gone")).lastSeenAt).toEqual(goneSeenBefore);

    const stale = await sweepStaleJobs(db, { enforce: true });
    expect(stale.closed).toBe(1);
    expect((await jobRow("back")).lifecycleState).toBe("active");
    expect((await jobRow("gone")).lifecycleState).toBe("closed");
  });

  describe("sweepStaleJobs board-health guard", () => {
    // The job was last stamped just past the 21-day TTL. The board's last ingest came minutes later: a
    // re-fetch inside markJobsPresent's 1-hour no-op window, which stamped the board but not the job.
    const lastSeen = sql`now() - interval '21 days' - interval '2 minutes'`;

    it("spares a job whose board was last ingested within the no-op window of its last stamp", async () => {
      await seedBoard(["j1"], sql`now() - interval '21 days' + interval '3 minutes'`);
      await db.update(jobs).set({ lastSeenAt: lastSeen });

      expect(await sweepStaleJobs(db)).toEqual({ closed: 0, wouldClose: 0 });
    });

    it("still counts the same stale job once its board has been ingested well after it was last seen", async () => {
      await seedBoard(["j1"], sql`now() - interval '21 days' + interval '2 hours'`);
      await db.update(jobs).set({ lastSeenAt: lastSeen });

      expect(await sweepStaleJobs(db)).toEqual({ closed: 0, wouldClose: 1 });
    });
  });
});
