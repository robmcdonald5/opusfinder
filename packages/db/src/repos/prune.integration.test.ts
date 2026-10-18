import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  companies,
  digestItems,
  digestRuns,
  digests,
  jobs,
  sourceRuns,
  user,
} from "@opusfinder/db/schema";
import { companySlug, jobId, type NormalizedJob, type UserId } from "@opusfinder/shared";

import { uid } from "@test/db/ids";
import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";

import { insertDigest, insertDigestItems, startDigestRun } from "./digests";
import { upsertCompany, upsertJobs } from "./jobs";
import { PRUNE_WINDOW_DAYS, pruneStaleJobs, runPrune } from "./prune";
import { pruneOplog } from "./prune-oplog";

// Which rows the two irreversible prunes actually delete, on real Postgres (prune.test.ts covers the emitted
// SQL shape only).

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

describe("TTL prunes (integration: real PGlite Postgres)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;
  const reader: UserId = uid(1);

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    await truncate(db, digestItems, digests, digestRuns, jobs, companies, sourceRuns, user);
    await db.insert(user).values({ id: reader, name: "Reader", email: "reader@test.local" });
  });
  afterAll(async () => {
    await close?.();
  });

  async function digestFor(runId: number): Promise<number> {
    return (
      await insertDigest(db, { userId: reader, digestRunId: runId, itemCount: 1, counts: {} })
    ).id;
  }

  async function jobsLeft(): Promise<string[]> {
    const rows = await db.select({ externalId: jobs.externalId }).from(jobs);
    return rows.map((r) => r.externalId as string).sort();
  }

  it("pruneStaleJobs deletes only closed jobs past the window that no digest references", async () => {
    const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
    const states = {
      active: { lifecycleState: "active", closedDaysAgo: null },
      "active-old-closed-at": { lifecycleState: "active", closedDaysAgo: 40 },
      "closed-recent": { lifecycleState: "closed", closedDaysAgo: 5 },
      "closed-no-clock": { lifecycleState: "closed", closedDaysAgo: null },
      "closed-old": { lifecycleState: "closed", closedDaysAgo: 40 },
      "closed-old-shown": { lifecycleState: "closed", closedDaysAgo: 40 },
      "closed-old-shown-no-snapshot": { lifecycleState: "closed", closedDaysAgo: 40 },
    } as const;
    await upsertJobs(db, companyId, Object.keys(states).map(job));
    const ids = new Map(
      (await db.select({ id: jobs.id, externalId: jobs.externalId }).from(jobs)).map((r) => [
        r.externalId as string,
        r.id,
      ]),
    );
    for (const [externalId, s] of Object.entries(states)) {
      await db
        .update(jobs)
        .set({
          lifecycleState: s.lifecycleState,
          closedAt:
            s.closedDaysAgo === null ? null : sql`now() - ${s.closedDaysAgo} * interval '1 day'`,
        })
        .where(eq(jobs.id, ids.get(externalId)!));
    }

    const digestId = await digestFor(await startDigestRun(db, "manual"));
    await insertDigestItems(db, digestId, reader, [
      {
        jobId: ids.get("closed-old-shown")!,
        rank: 1,
        score: 0.5,
        reason: "r",
        jobTitle: "Engineer",
        companySlug: "acme",
        applyUrl: "https://example.test/shown",
        locations: [],
        remote: false,
        contentSignature: null,
      },
    ]);
    // A history row from before the display snapshot: once its job is gone it has nothing to render, so its
    // job must stay unprunable even after the referenced-job clause is relaxed.
    await db.insert(digestItems).values({
      digestId,
      userId: reader,
      jobId: ids.get("closed-old-shown-no-snapshot")!,
      rank: 2,
      score: 0.25,
      reason: "r",
    });

    const all = Object.keys(states).sort();
    expect(await pruneStaleJobs(db)).toMatchObject({ closedTotal: 5, closedOld: 3, prunable: 1 });
    expect(await jobsLeft()).toEqual(all);

    expect(await pruneStaleJobs(db, { apply: true })).toMatchObject({ prunable: 1, deleted: 1 });
    expect(await jobsLeft()).toEqual(all.filter((k) => k !== "closed-old"));
  });

  /** Insert closed jobs, each closed the given number of days ago; returns nothing (read back by externalId). */
  async function closedJobs(closedDaysAgo: Record<string, number>): Promise<void> {
    const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
    await upsertJobs(db, companyId, Object.keys(closedDaysAgo).map(job));
    for (const [externalId, days] of Object.entries(closedDaysAgo)) {
      await db
        .update(jobs)
        .set({ lifecycleState: "closed", closedAt: sql`now() - ${days} * interval '1 day'` })
        .where(eq(jobs.externalId, jobId(externalId)));
    }
  }

  it("the prune function's window is PRUNE_WINDOW_DAYS: a day inside it stays, a day past it goes", async () => {
    await closedJobs({ inside: PRUNE_WINDOW_DAYS - 1, past: PRUNE_WINDOW_DAYS + 1 });
    expect(await pruneStaleJobs(db, { apply: true })).toMatchObject({ prunable: 1, deleted: 1 });
    expect(await jobsLeft()).toEqual(["inside"]);
  });

  it("runPrune only counts unless applied, deletes at most maxRows, and records a prune run each time", async () => {
    await closedJobs({ a: 40, b: 50, c: 60 });

    expect(await runPrune(db, { apply: false, maxRows: 2 })).toEqual({ prunable: 3, deleted: 0 });
    expect(await jobsLeft()).toEqual(["a", "b", "c"]);
    expect(await runPrune(db, { apply: true, maxRows: 2 })).toEqual({ prunable: 3, deleted: 2 });
    expect(await jobsLeft()).toHaveLength(1);
    expect(await runPrune(db, { apply: true, maxRows: 2 })).toEqual({ prunable: 1, deleted: 1 });
    expect(await jobsLeft()).toEqual([]);

    const runs = await db
      .select({
        pipeline: sourceRuns.pipeline,
        status: sourceRuns.status,
        counts: sourceRuns.counts,
      })
      .from(sourceRuns)
      .orderBy(sourceRuns.id);
    expect(runs).toEqual([
      { pipeline: "prune", status: "ok", counts: { prunable: 3, deleted: 0 } },
      { pipeline: "prune", status: "ok", counts: { prunable: 3, deleted: 2 } },
      { pipeline: "prune", status: "ok", counts: { prunable: 1, deleted: 1 } },
    ]);
  });

  it("the prune function deletes nothing for a zero, negative or NULL max", async () => {
    await closedJobs({ old: 40 });
    for (const max of [sql`0`, sql`-5`, sql`NULL`]) {
      await db.execute(sql`SELECT public.prune_closed_jobs(${max}, true)`);
    }
    expect(await jobsLeft()).toEqual(["old"]);
  });

  it("pruneOplog deletes only digest runs past the window that no digest references", async () => {
    const [oldShown, oldEmpty, recent] = [
      await startDigestRun(db, "cron"),
      await startDigestRun(db, "cron"),
      await startDigestRun(db, "cron"),
    ];
    await db
      .update(digestRuns)
      .set({ startedAt: sql`now() - interval '100 days'` })
      .where(inArray(digestRuns.id, [oldShown, oldEmpty]));
    await digestFor(oldShown);

    await pruneOplog(db, { apply: true });

    const left = (await db.select({ id: digestRuns.id }).from(digestRuns)).map((r) => r.id);
    expect(left.sort((a, b) => a - b)).toEqual([oldShown, recent]);
  });
});
