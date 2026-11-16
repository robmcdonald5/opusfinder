import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@opusfinder/db";
import { upsertCompany, upsertJobs } from "@opusfinder/db/repos";
import { SCRAPERS_WORKER } from "@opusfinder/db/roles";
import { companies, jobs, locationStrings, places, sourceRuns } from "@opusfinder/db/schema";
import { companySlug, jobId } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";
import { P, seedPlaces } from "@test/db/places";
import { setUpRole } from "@test/db/role";
import { truncate } from "@test/db/truncate";
import { rejectionOf } from "@test/rejection";

import type { LocationAnswer, LocationModel, LocationRequest } from "./model";
import { runLocationResolve } from "./run";

// The scrapers Worker's location run against real PGlite with a stub model, AS the Worker's own database
// role: a missing grant fails a query, which fails the run. apps/scrapers' tests compile under Workers
// types, without PGlite, so the run's behaviour is pinned here and the Worker's wiring there.

/** The Worker's bounds (apps/scrapers/src/index.ts). */
const BOUNDS = { apply: true, maxPairs: 300, maxRunMs: 4 * 60_000 };

const SPEND = {
  inputTokens: 300,
  outputTokens: 40,
  cacheReadTokens: 3000,
  cacheCreationTokens: 0,
  costUsd: 0.001,
};
const COLUMBUS: LocationAnswer = {
  status: "answered",
  text: JSON.stringify({
    reason: "City and state.",
    places: [{ city: "Columbus", region: "Ohio", country: "US", kind: "city" }],
    remoteCountries: [],
    areas: [],
    confidence: "high",
  }),
  spend: SPEND,
};
const TRANSIENT: LocationAnswer = { status: "failed", reason: "OpenRouter 503 error" };

/** The location text a request asks about (its user message's last line). */
function rawOf(request: LocationRequest): string {
  const line = request.user.split("\n").at(-1)!;
  return JSON.parse(line.slice("Location text: ".length)) as string;
}

/** A model that places every string in Columbus, bar the ones `failing` names. */
function stubModel(failing: (raw: string) => boolean = () => false) {
  const asked: string[] = [];
  const model: LocationModel = {
    generate: vi.fn(async (request: LocationRequest) => {
      asked.push(rawOf(request));
      return failing(rawOf(request)) ? TRANSIENT : COLUMBUS;
    }),
    submitBatch: vi.fn(),
    collectBatch: vi.fn(),
  };
  return { model, asked };
}

describe("the location run as scrapers_worker (integration: real PGlite, stub model)", () => {
  let db: Db;
  let pg: PGlite;
  let close: (() => Promise<void>) | undefined;
  let acme: number;

  beforeAll(async () => {
    ({ db, client: pg, close } = await createTestDb());
    await seedPlaces(db);
    await setUpRole(pg, SCRAPERS_WORKER);
  });
  beforeEach(async () => {
    await truncate(db, companies, jobs, locationStrings, sourceRuns);
    acme = await upsertCompany(db, companySlug("acme"), "greenhouse");
  });
  afterEach(async () => {
    await pg.exec("RESET ROLE");
  });
  afterAll(async () => {
    await truncate(db, places);
    await close?.();
  });

  /** One job per entry, listing those location strings. */
  async function seedJobs(locations: string[][]): Promise<void> {
    await upsertJobs(
      db,
      acme,
      locations.map((l, i) => ({
        source: "greenhouse" as const,
        externalId: jobId(`j${i}`),
        title: `Role ${i}`,
        companySlug: companySlug("acme"),
        locations: l,
        remote: false,
        descriptionText: `about ${i}`,
        applyUrl: `https://example.test/${i}`,
        postedAt: null,
      })),
    );
  }

  /** A run as the Worker's role. */
  async function run(
    model: LocationModel,
    opts: Partial<Parameters<typeof runLocationResolve>[2]> = {},
  ) {
    await pg.exec(`SET ROLE ${SCRAPERS_WORKER.name}`);
    try {
      return await runLocationResolve(db, model, { ...BOUNDS, ...opts });
    } finally {
      await pg.exec("RESET ROLE");
    }
  }

  async function storedRaws(): Promise<string[]> {
    const rows = await db.select({ raw: locationStrings.raw }).from(locationStrings);
    return rows.map((r) => r.raw).sort();
  }

  async function runRows() {
    return db.select().from(sourceRuns).orderBy(sourceRuns.id);
  }

  it("drains a 2,000-string backlog over successive runs, none asking more than its bound", async () => {
    await seedJobs(Array.from({ length: 2000 }, (_, i) => [`Office ${i}`]));
    const { model, asked } = stubModel();

    const runs = [];
    for (let i = 0; i < 7; i++) runs.push(await run(model));

    expect(runs.map((r) => r.counts.pending)).toEqual([2000, 1700, 1400, 1100, 800, 500, 200]);
    expect(runs.map((r) => r.counts.asked)).toEqual([300, 300, 300, 300, 300, 300, 200]);
    expect(runs.map((r) => r.stopped)).toEqual([
      ...Array.from({ length: 6 }, () => "pair-bound"),
      "drained",
    ]);
    expect(asked).toHaveLength(2000);
    expect(new Set(asked).size).toBe(2000); // no string was paid for twice
    expect(await storedRaws()).toHaveLength(2000);

    // The next run finds nothing waiting and asks nothing.
    const idle = await run(model);
    expect(idle).toMatchObject({ stopped: "drained", counts: { pending: 0, asked: 0 } });
    expect(asked).toHaveLength(2000);

    const rows = await runRows();
    expect(rows.map((r) => [r.pipeline, r.status])).toEqual(
      Array.from({ length: 8 }, () => ["locations", "ok"]),
    );
    expect(rows[0]!.counts).toEqual({
      pending: 2000,
      asked: 300,
      resolved: 300,
      unanswered: 0,
      failed: 0,
      unmatchedPlaces: 0,
      inputTokens: 300 * SPEND.inputTokens,
      outputTokens: 300 * SPEND.outputTokens,
      cacheReadTokens: 300 * SPEND.cacheReadTokens,
      cacheCreationTokens: 0,
      costUsd: expect.closeTo(300 * SPEND.costUsd, 6),
    });
  }, 120_000);

  it("only counts the strings waiting when it isn't applying", async () => {
    await seedJobs([["Columbus, OH"], ["Dublin"], ["Dublin"]]);
    const { model } = stubModel();
    const askLast = [{ companyId: acme, raw: "Dublin" }];

    const result = await run(model, { apply: false, askLast });

    expect(result).toMatchObject({ stopped: "counted", counts: { pending: 2, asked: 0 } });
    expect(result.failedPairs).toEqual(askLast); // the memory is left as it was
    expect(model.generate).not.toHaveBeenCalled();
    expect(await storedRaws()).toEqual([]);
    expect(await runRows()).toMatchObject([
      { pipeline: "locations", status: "ok", counts: { pending: 2, asked: 0 } },
    ]);
  });

  it("asks the strings that failed last run after every other waiting string", async () => {
    // Most-listed first, so "Flaky" (three jobs) heads the queue.
    await seedJobs([["Flaky"], ["Flaky"], ["Flaky"], ["Second"], ["Second"], ["Third"]]);
    const flaky = { companyId: acme, raw: "Flaky" };

    const first = stubModel((raw) => raw === "Flaky");
    const one = await run(first.model);
    expect(first.asked[0]).toBe("Flaky");
    expect(one).toMatchObject({
      stopped: "drained",
      counts: { asked: 3, resolved: 2, failed: 1 },
      failedPairs: [flaky],
    });
    expect(await storedRaws()).toEqual(["Second", "Third"]);

    // The next run, still failing: with nothing else waiting it is asked again, and handed back again.
    await seedJobs([["Flaky"], ["Flaky"], ["Flaky"], ["Fourth"], ["Fourth"], ["Fifth"]]);
    const second = stubModel((raw) => raw === "Flaky");
    const two = await run(second.model, { askLast: one.failedPairs });
    expect(second.asked).toEqual(["Fourth", "Fifth", "Flaky"]);
    expect(two).toMatchObject({ counts: { resolved: 2, failed: 1 }, failedPairs: [flaky] });

    // And once it answers, the memory empties.
    const third = stubModel();
    const three = await run(third.model, { askLast: two.failedPairs });
    expect(three).toMatchObject({ counts: { resolved: 1, failed: 0 }, failedPairs: [] });
    expect(await storedRaws()).toContain("Flaky");
  });

  it("keeps a failed string in the memory when the bound stops the run before reaching it", async () => {
    await seedJobs([["Flaky"], ["Flaky"], ["Second"], ["Third"]]);
    const flaky = { companyId: acme, raw: "Flaky" };
    const { model, asked } = stubModel();

    const result = await run(model, { maxPairs: 2, askLast: [flaky] });

    expect(asked.sort()).toEqual(["Second", "Third"]);
    expect(result).toMatchObject({ stopped: "pair-bound", failedPairs: [flaky] });
  });

  it("keeps the failed strings it didn't get to when a bound stops it part-way through them", async () => {
    await seedJobs([["New A"], ["New B"], ["Old 1"], ["Old 2"], ["Old 3"]]);
    const askLast = ["Old 1", "Old 2", "Old 3"].map((raw) => ({ companyId: acme, raw }));
    const { model, asked } = stubModel();

    // Room for the two new strings and one of last run's three.
    const result = await run(model, { maxPairs: 3, askLast });

    expect(asked).toEqual(["New A", "New B", "Old 1"]);
    expect(result.stopped).toBe("pair-bound");
    // "Old 1" resolved, so it is no longer waiting and its place on the list is harmless.
    expect(result.failedPairs).toEqual(askLast);
  });

  it("doesn't read last run's failures failing again as an outage, however many they are", async () => {
    await seedJobs([["Old 1"], ["Old 2"], ["Old 3"], ["Old 4"]]);
    const askLast = ["Old 1", "Old 2", "Old 3", "Old 4"].map((raw) => ({ companyId: acme, raw }));
    const { model, asked } = stubModel(() => true);

    // Nothing new is waiting, so the run is these four alone, and all four fail again.
    const result = await run(model, { askLast });

    expect(asked).toHaveLength(4);
    expect(result).toMatchObject({
      stopped: "model-unavailable",
      counts: { asked: 4, resolved: 0, failed: 4 },
    });
    expect(result.unavailable).toBeUndefined();
    expect(result.failedPairs).toEqual(askLast);
    expect(await runRows()).toMatchObject([{ pipeline: "locations", status: "ok" }]);
  });

  it("drops the memory once nothing is waiting", async () => {
    const { model } = stubModel();
    const result = await run(model, { askLast: [{ companyId: acme, raw: "Gone" }] });
    expect(result).toMatchObject({ stopped: "drained", failedPairs: [], counts: { pending: 0 } });
  });

  it("records an error and stores nothing when the model fails every request from the start", async () => {
    await seedJobs(Array.from({ length: 40 }, (_, i) => [`Office ${i}`]));
    const { model, asked } = stubModel(() => true);

    const result = await run(model);

    // It stops after the first chunk instead of failing its way through the queue.
    expect(asked).toHaveLength(30);
    expect(result).toMatchObject({
      stopped: "model-unavailable",
      counts: { pending: 40, asked: 30, resolved: 0, failed: 30 },
    });
    expect(result.unavailable).toMatch(/all 30 requests failed \(OpenRouter 503 error\)/);
    expect(result.failedPairs).toHaveLength(30);
    expect(await storedRaws()).toEqual([]);
    const [row] = await runRows();
    expect(row).toMatchObject({ pipeline: "locations", status: "error" });
    expect(row!.errorSample).toMatch(/unavailable: all 30 requests failed/);

    // The next run asks the ten it never reached first, so a chunk that keeps failing can't block them.
    const next = stubModel((raw) => result.failedPairs.some((p) => p.raw === raw));
    const after = await run(next.model, { askLast: result.failedPairs });
    expect(next.asked.slice(0, 10).sort()).toEqual(
      Array.from({ length: 40 }, (_, i) => `Office ${i}`)
        .filter((raw) => !result.failedPairs.some((p) => p.raw === raw))
        .sort(),
    );
    // Something was stored this time, so the chunk that failed again is a partial run, not an outage.
    expect(after).toMatchObject({
      stopped: "model-unavailable",
      counts: { resolved: 10, failed: 30 },
    });
    expect(after.unavailable).toBeUndefined();
    expect((await runRows())[1]).toMatchObject({ status: "ok" });
  });

  it("starts no chunk past its time bound", async () => {
    await seedJobs([["Columbus, OH"]]);
    const { model } = stubModel();

    const result = await run(model, { maxRunMs: 0 });

    expect(result).toMatchObject({ stopped: "time-bound", counts: { pending: 1, asked: 0 } });
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("finishes the row as an error and re-throws a failure that isn't the model's", async () => {
    await seedJobs([["Columbus, OH"]]);
    const { model } = stubModel();
    vi.mocked(model.generate).mockRejectedValue(new Error("OPENROUTER_API_KEY is not set"));

    const error = await rejectionOf(run(model));

    expect(error.message).toBe("OPENROUTER_API_KEY is not set");
    expect(await runRows()).toMatchObject([
      { pipeline: "locations", status: "error", errorSample: "OPENROUTER_API_KEY is not set" },
    ]);
  });

  it("stores what the check made of an answer: the place, under the current prompt version", async () => {
    await seedJobs([["Columbus, OH"]]);
    await run(stubModel().model);
    const [row] = await db.select().from(locationStrings);
    expect(row).toMatchObject({ companyId: acme, raw: "Columbus, OH", placeIds: [P.COLUMBUS_OH] });
  });
});
