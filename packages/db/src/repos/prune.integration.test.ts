import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import { companies, digestItems, digestRuns, digests, jobs, user } from "@opusfinder/db/schema";
import { companySlug, jobId, type NormalizedJob, type UserId } from "@opusfinder/shared";

import { uid } from "@test/db/ids";
import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";

import { insertDigest, insertDigestItems, startDigestRun } from "./digests";
import { upsertCompany, upsertJobs } from "./jobs";
import { pruneStaleJobs } from "./prune";
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
    await truncate(db, digestItems, digests, digestRuns, jobs, companies, user);
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
