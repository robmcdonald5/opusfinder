import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  digestRuns,
  digests,
  user,
  type DigestDeliveryStatus,
  type RunCounts,
} from "@opusfinder/db/schema";
import type { UserId } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";

import { listDigestCosts, summarizeDigestCosts } from "./digest-costs";
import { startDigestRun } from "./digests";

// What this file proves: listDigestCosts reads each counts shape the digest has written (today's keys, the
// early-exit records, and the pre-cost-tracking rows still in production) into per-stage tokens and $,
// keeps a missing cost apart from $0, and applies the user / since / limit filters in SQL.

const A = "aaaaaaaa-0000-4000-8000-000000000001" as UserId;
const B = "bbbbbbbb-0000-4000-8000-000000000002" as UserId;

const RERANK: RunCounts = {
  rerankScored: 150,
  rerankInputTokens: 2_000,
  rerankOutputTokens: 900,
  rerankCacheReadTokens: 40_000,
  rerankCacheCreationTokens: 500,
  rerankCostUsd: 0.012,
};
const SYNTHESIS: RunCounts = {
  synthesisInputTokens: 600,
  synthesisOutputTokens: 3_000,
  synthesisCacheReadTokens: 9_000,
  synthesisCacheCreationTokens: 1_000,
  synthesisCostUsd: 0.03,
};

describe("listDigestCosts — per-digest judge and notes cost from digests.counts (integration: real PGlite)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    await truncate(db, digests, digestRuns, user);
    for (const id of [A, B]) {
      await db
        .insert(user)
        .values({ id, name: "User", email: `${id}@test.local`, emailVerified: true });
    }
    // One run per row: (user, run) is unique.
    const seed = async (
      userId: UserId,
      createdAt: string,
      itemCount: number,
      deliveryStatus: DigestDeliveryStatus,
      counts: RunCounts,
    ) => {
      const digestRunId = await startDigestRun(db, "cron");
      await db
        .insert(digests)
        .values({
          userId,
          digestRunId,
          itemCount,
          deliveryStatus,
          counts,
          createdAt: new Date(createdAt),
        });
    };
    // Production's rows: written before token and cost tracking, so no rerankCostUsd.
    await seed(B, "2026-08-02T13:04:16Z", 12, "delivered", {
      candidates: 150,
      reranked: 12,
      rerankCacheReadTokens: 38_000,
      rerankCacheCreationTokens: 0,
      probedOk: 12,
    });
    await seed(A, "2026-10-20T13:00:00Z", 10, "delivered", {
      candidates: 150,
      reranked: 10,
      ...RERANK,
      ...SYNTHESIS,
    });
    // Nothing cleared the score floor: the judge ran, synthesis didn't.
    await seed(A, "2026-10-21T13:00:00Z", 0, "none", { candidates: 150, ...RERANK, reranked: 0 });
    // Nothing retrieved: no paid stage ran.
    await seed(A, "2026-10-22T13:00:00Z", 0, "none", { candidates: 0 });
    // Every apply URL was dead: 0 items left, but both stages ran and were paid for.
    await seed(B, "2026-10-23T13:00:00Z", 0, "none", {
      candidates: 150,
      reranked: 4,
      ...RERANK,
      ...SYNTHESIS,
      probed404Dropped: 4,
    });
  });
  afterAll(async () => {
    await close?.();
  });

  const judge = { inputTokens: 42_500, outputTokens: 900, costUsd: 0.012 };
  const notes = { inputTokens: 10_600, outputTokens: 3_000, costUsd: 0.03 };

  it("reads every counts shape, newest first, with the user as an 8-character prefix", async () => {
    const rows = await listDigestCosts(db, { limit: 30 });
    expect(rows).toEqual([
      {
        id: 5,
        createdAt: new Date("2026-10-23T13:00:00Z"),
        userPrefix: "bbbbbbbb",
        deliveryStatus: "none",
        itemCount: 0,
        judge,
        notes,
        totalUsd: expect.closeTo(0.042, 10),
      },
      {
        id: 4,
        createdAt: new Date("2026-10-22T13:00:00Z"),
        userPrefix: "aaaaaaaa",
        deliveryStatus: "none",
        itemCount: 0,
        judge: null,
        notes: null,
        totalUsd: 0,
      },
      {
        id: 3,
        createdAt: new Date("2026-10-21T13:00:00Z"),
        userPrefix: "aaaaaaaa",
        deliveryStatus: "none",
        itemCount: 0,
        judge,
        notes: null,
        totalUsd: 0.012,
      },
      {
        id: 2,
        createdAt: new Date("2026-10-20T13:00:00Z"),
        userPrefix: "aaaaaaaa",
        deliveryStatus: "delivered",
        itemCount: 10,
        judge,
        notes,
        totalUsd: expect.closeTo(0.042, 10),
      },
      {
        id: 1,
        createdAt: new Date("2026-08-02T13:04:16Z"),
        userPrefix: "bbbbbbbb",
        deliveryStatus: "delivered",
        itemCount: 12,
        judge: { inputTokens: null, outputTokens: null, costUsd: null },
        notes: { inputTokens: null, outputTokens: null, costUsd: null },
        totalUsd: null,
      },
    ]);
  });

  it("totals and averages only the digests with a known cost", async () => {
    const summary = summarizeDigestCosts(await listDigestCosts(db, { limit: 30 }));
    expect(summary).toEqual({
      digests: 5,
      priced: 4,
      totalUsd: expect.closeTo(0.096, 10),
      meanUsd: expect.closeTo(0.024, 10),
    });
    expect(summarizeDigestCosts([])).toEqual({ digests: 0, priced: 0, totalUsd: 0, meanUsd: null });
  });

  it("filters by user id or prefix, since and limit", async () => {
    const ids = async (filter: Parameters<typeof listDigestCosts>[1]) =>
      (await listDigestCosts(db, filter)).map((r) => r.id);
    expect(await ids({ userPrefix: "BBBB", limit: 30 })).toEqual([5, 1]);
    expect(await ids({ userPrefix: A, limit: 30 })).toEqual([4, 3, 2]);
    expect(await ids({ since: new Date("2026-10-21T00:00:00Z"), limit: 30 })).toEqual([5, 4, 3]);
    expect(
      await ids({ userPrefix: "aaaa", since: new Date("2026-10-22T00:00:00Z"), limit: 30 }),
    ).toEqual([4]);
    expect(await ids({ limit: 2 })).toEqual([5, 4]);
  });
});
