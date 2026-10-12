import { eq, sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import { companies, jobs } from "@opusfinder/db/schema";
import { companySlug, jobId, type NormalizedJob } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";

import { upsertCompany, upsertJobs } from "./jobs";
import {
  ABSENCE_CLOSE_THRESHOLD,
  markJobsPresent,
  sweepLifecycle,
  sweepStaleJobs,
} from "./lifecycle";

// The lifecycle writers' row semantics on real Postgres (lifecycle.test.ts covers the emitted SQL shape only).

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

describe("lifecycle writers (integration: real PGlite Postgres)", () => {
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
      .set({
        lifecycleState: "closed",
        closedAt: sql`now() - interval '9 days'`,
        consecutiveAbsences: ABSENCE_CLOSE_THRESHOLD,
      })
      .where(eq(jobs.externalId, jobId("back")));
    const goneSeenBefore = (await jobRow("gone")).lastSeenAt;

    // markJobsPresent failed this tick (never called), so the sweep is the only revive.
    const sweep = await sweepLifecycle(db, companyId, ["back"], { enforce: true });
    expect(sweep.revived).toBe(1);
    const back = await jobRow("back");
    expect(back).toMatchObject({
      lifecycleState: "active",
      closedAt: null,
      consecutiveAbsences: 0,
    });
    expect(back.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // An absent row's clock is untouched — it keeps ageing toward the stale close.
    expect((await jobRow("gone")).lastSeenAt).toEqual(goneSeenBefore);

    const stale = await sweepStaleJobs(db, { enforce: true });
    expect(stale.closed).toBe(1);
    expect((await jobRow("back")).lifecycleState).toBe("active");
    expect((await jobRow("gone")).lifecycleState).toBe("closed");
  });

  describe("absence streak", () => {
    it("enforce closes a job on its third consecutive absence, stamps closed_at, and leaves it alone after", async () => {
      const companyId = await seedBoard(["stay", "gone"], sql`now()`);
      const sweep = () => sweepLifecycle(db, companyId, ["stay"], { enforce: true });

      expect(await sweep()).toEqual({ revived: 0, swept: 1, closed: 0, wouldClose: 0 });
      expect(await sweep()).toEqual({ revived: 0, swept: 1, closed: 0, wouldClose: 0 });
      expect((await jobRow("gone")).lifecycleState).toBe("active");
      expect(await sweep()).toEqual({ revived: 0, swept: 0, closed: 1, wouldClose: 0 });

      const gone = await jobRow("gone");
      expect(gone.lifecycleState).toBe("closed");
      expect(gone.closedAt).not.toBeNull();
      expect((await jobRow("stay")).lifecycleState).toBe("active");
      // A closed row is out of the sweep, so its prune clock is never re-stamped.
      expect(await sweep()).toEqual({ revived: 0, swept: 0, closed: 0, wouldClose: 0 });
      expect((await jobRow("gone")).closedAt).toEqual(gone.closedAt);
    });

    it("shadow caps the streak and only tallies the would-close; the first enforced sweep then closes it", async () => {
      const companyId = await seedBoard(["stay", "gone"], sql`now()`);
      const sweep = (enforce: boolean) => sweepLifecycle(db, companyId, ["stay"], { enforce });

      await sweep(false);
      await sweep(false);
      expect(await sweep(false)).toEqual({ revived: 0, swept: 0, closed: 0, wouldClose: 1 });
      expect(await sweep(false)).toEqual({ revived: 0, swept: 0, closed: 0, wouldClose: 1 });
      expect(await jobRow("gone")).toMatchObject({
        lifecycleState: "active",
        closedAt: null,
        consecutiveAbsences: ABSENCE_CLOSE_THRESHOLD,
      });

      expect(await sweep(true)).toEqual({ revived: 0, swept: 0, closed: 1, wouldClose: 0 });
      const gone = await jobRow("gone");
      expect(gone.lifecycleState).toBe("closed");
      expect(gone.closedAt).not.toBeNull();
    });

    it("a posting listed on a visit that skipped the sweep starts its streak over", async () => {
      const companyId = await seedBoard(["p", "q"], sql`now()`);
      const absent = () => sweepLifecycle(db, companyId, ["q"], { enforce: true });

      await absent();
      await absent();
      // Listed again, but a rate limit skipped this visit's sweep: only the presence stamp ran.
      expect(await markJobsPresent(db, companyId, ["p", "q"])).toEqual({ revived: 1 });
      await absent();

      expect(await jobRow("p")).toMatchObject({ lifecycleState: "active", consecutiveAbsences: 1 });
    });
  });

  describe("markJobsPresent", () => {
    it("revives a listed closed job and clears its close clock and streak", async () => {
      const companyId = await seedBoard(["back"], sql`now()`);
      await db.update(jobs).set({
        lifecycleState: "closed",
        closedAt: sql`now() - interval '2 days'`,
        consecutiveAbsences: ABSENCE_CLOSE_THRESHOLD,
      });

      expect(await markJobsPresent(db, companyId, ["back"])).toEqual({ revived: 1 });
      expect(await jobRow("back")).toMatchObject({
        lifecycleState: "active",
        closedAt: null,
        consecutiveAbsences: 0,
      });
    });

    it("leaves a row stamped within the hour alone and re-stamps an older one", async () => {
      const companyId = await seedBoard(["fresh", "aged"], sql`now()`);
      await db
        .update(jobs)
        .set({ lastSeenAt: sql`now() - interval '30 minutes'` })
        .where(eq(jobs.externalId, jobId("fresh")));
      await db
        .update(jobs)
        .set({ lastSeenAt: sql`now() - interval '2 hours'` })
        .where(eq(jobs.externalId, jobId("aged")));
      const freshSeen = (await jobRow("fresh")).lastSeenAt;

      expect(await markJobsPresent(db, companyId, ["fresh", "aged"])).toEqual({ revived: 0 });
      expect((await jobRow("fresh")).lastSeenAt).toEqual(freshSeen);
      expect((await jobRow("aged")).lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });
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
