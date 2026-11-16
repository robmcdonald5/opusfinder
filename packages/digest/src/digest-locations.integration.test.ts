import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  countMissingPairs,
  upsertCompany,
  upsertJobs,
  upsertLocationStrings,
  writeJobEmbeddings,
} from "@opusfinder/db/repos";
import {
  digests,
  jobs,
  locationStrings,
  places,
  user,
  userCvFiles,
  userPreferences,
  userProfiles,
} from "@opusfinder/db/schema";
import {
  runLocationResolve,
  type LocationModel,
  type LocationRequest,
} from "@opusfinder/locations";
import type { RerankCandidate } from "@opusfinder/rerank";
import { companySlug, jobId } from "@opusfinder/shared";

import { uid } from "@test/db/ids";
import { createTestDb } from "@test/db/pglite";
import { P, seedPlaces } from "@test/db/places";
import { truncate } from "@test/db/truncate";
import { oneHot, TEST_MODEL } from "@test/db/vectors";
import { recordingStep } from "@test/digest/stubs";

import { runOrchestrator, runPerUser, type DigestDeps } from "./digest";

// The digest and the location run together, on real PGlite: the digest no longer resolves location strings
// (the scrapers Worker does, on its own cron), so a backlog of them can't hold a run up. What a digest does
// with a job whose string isn't resolved yet: it holds the job back from a user with a home place, neither
// failing the run nor passing the job as if it were local to everyone, and the job reaches that user in the
// first digest after the location run resolves it.

/** The backlog: one job per string, none resolved. The first five are embedded, so retrieval can see them. */
const BACKLOG = 2000;
const EMBEDDED = 5;
/** Where the stub model places the embedded jobs' strings: three in Columbus, two in Dallas. */
const IN_COLUMBUS = new Set(["Office 0", "Office 1", "Office 2"]);

/** The scrapers Worker's bounds for a location run (apps/scrapers/src/index.ts). */
const RUN_BOUNDS = { apply: true, maxPairs: 300, maxRunMs: 4 * 60_000 };

function rawOf(request: LocationRequest): string {
  const line = request.user.split("\n").at(-1)!;
  return JSON.parse(line.slice("Location text: ".length)) as string;
}

/** Places every string in Dallas, TX, bar the three it places in Columbus, OH. */
function stubModel(): LocationModel {
  return {
    generate: vi.fn(async (request: LocationRequest) => {
      const [city, region] = IN_COLUMBUS.has(rawOf(request))
        ? ["Columbus", "Ohio"]
        : ["Dallas", "Texas"];
      return {
        status: "answered" as const,
        text: JSON.stringify({
          reason: "City and state.",
          places: [{ city, region, country: "US", kind: "city" }],
          remoteCountries: [],
          areas: [],
          confidence: "high",
        }),
      };
    }),
    submitBatch: vi.fn(),
    collectBatch: vi.fn(),
  };
}

describe("a digest while location strings wait to be resolved (integration: real PGlite)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;
  const userId = uid(1);
  /** Job ids by external id. */
  const ids = new Map<string, number>();
  /** The candidates each digest handed to the rerank. */
  const reranked: RerankCandidate[][] = [];

  /** Scores every candidate under the digest's floor, so each run ends right after retrieval and rerank. */
  const deps = (): DigestDeps => ({
    db,
    rerank: async (_profile, candidates) => {
      reranked.push(candidates);
      return {
        orderedIds: candidates.map((c) => c.id),
        scores: new Map(candidates.map((c) => [c.id, 0.1])),
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        cache: { creationInputTokens: 0, readInputTokens: 0 },
      };
    },
    batch: { submit: vi.fn(), poll: vi.fn(), collect: vi.fn() },
    email: { send: vi.fn(), lastEvent: vi.fn() },
    probe: vi.fn(),
  });

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedPlaces(db);

    const acme = await upsertCompany(db, companySlug("acme"), "greenhouse");
    const posting = (key: string, location: string) => ({
      source: "greenhouse" as const,
      externalId: jobId(key),
      title: `Role ${key}`,
      companySlug: companySlug("acme"),
      locations: [location],
      remote: false,
      descriptionText: `Description for ${key}`,
      applyUrl: `https://example.test/${key}`,
      postedAt: null,
    });
    await upsertJobs(db, acme, [
      posting("resolved", "Columbus, OH"),
      ...Array.from({ length: BACKLOG }, (_, i) => posting(`waiting-${i}`, `Office ${i}`)),
    ]);
    const embedded = ["resolved", ...Array.from({ length: EMBEDDED }, (_, i) => `waiting-${i}`)];
    const rows = await db
      .select({ id: jobs.id, externalId: jobs.externalId })
      .from(jobs)
      .where(inArray(jobs.externalId, embedded.map(jobId)));
    for (const row of rows) ids.set(row.externalId, row.id);
    await writeJobEmbeddings(
      db,
      embedded.map((key) => ({ id: ids.get(key)!, embedding: oneHot(0) })),
      TEST_MODEL,
    );
    // The one string resolved before the backlog arrived.
    await upsertLocationStrings(db, [
      {
        companyId: acme,
        raw: "Columbus, OH",
        placeIds: [P.COLUMBUS_OH],
        remoteCountries: [],
        unmatched: [],
        confidence: "high",
        reason: "fixture",
        promptVersion: "test",
      },
    ]);

    // An eligible recipient living in Columbus, OH, matching every embedded job equally.
    await db
      .insert(user)
      .values({ id: userId, name: "User", email: "user@test.local", emailVerified: true });
    const [cv] = await db
      .insert(userCvFiles)
      .values({
        userId,
        r2OriginalKey: "cv/original/1.pdf",
        filename: "cv.pdf",
        contentType: "application/pdf",
        byteSize: 1024,
      })
      .returning({ id: userCvFiles.id });
    await db.insert(userProfiles).values({
      userId,
      structured: { summary: "backend engineer", skills: ["ts"], targetRoles: ["Platform"] },
      embedding: oneHot(0),
      embeddingModel: TEST_MODEL,
      sourceCvFileId: cv!.id,
    });
    await db.insert(userPreferences).values({
      userId,
      unsubscribeToken: "tok-1",
      digestApprovedAt: new Date(),
      homePlaceId: P.COLUMBUS_OH,
      radiusMiles: 50,
    });
  }, 120_000);
  afterAll(async () => {
    await truncate(db, places);
    await close?.();
  });

  /** One manual digest run: the orchestrator, then the per-user function for each recipient it fanned out. */
  async function digestRun() {
    const orchestrator = recordingStep();
    await runOrchestrator(deps(), { data: { trigger: "manual" } }, orchestrator.tools);
    const events = orchestrator.sentEvents.flatMap(
      (sent) => sent.events as { data: { userId: string; digestRunId: number } }[],
    );
    const outcomes = [];
    for (const event of events) {
      outcomes.push(await runPerUser(deps(), event, recordingStep().tools));
    }
    return { steps: orchestrator.runs, recipients: events.map((e) => e.data.userId), outcomes };
  }

  /** The job keys the newest digest's rerank was handed. */
  function lastCandidates(): string[] {
    const byId = new Map([...ids].map(([key, id]) => [id, key]));
    return reranked
      .at(-1)!
      .map((c) => byId.get(c.id)!)
      .sort();
  }

  async function storedStrings(): Promise<number> {
    return (await db.select({ raw: locationStrings.raw }).from(locationStrings)).length;
  }

  it("fans out past 2,000 unresolved strings, holds their jobs back, and shows them once the location run has drained", async () => {
    expect(await countMissingPairs(db)).toBe(BACKLOG);

    // 1. The digest with the whole backlog waiting: straight to its fan-out, resolving nothing.
    const before = await digestRun();
    expect(before.steps).toEqual(["start-run", "fetch-recipients", "finish-run"]);
    expect(before.recipients).toEqual([userId]);
    expect(await storedStrings()).toBe(1);
    expect(await countMissingPairs(db)).toBe(BACKLOG);
    // The run completes for the user. Of six equally close jobs it considers only the one whose string is
    // resolved and local: the five whose strings wait are neither an error nor passed as local.
    expect(before.outcomes).toEqual([{ userId, skipped: "no-strong-matches" }]);
    expect(lastCandidates()).toEqual(["resolved"]);

    // 2. The location run drains the backlog over successive runs, each inside its bound.
    const model = stubModel();
    const asked: number[] = [];
    while ((await countMissingPairs(db)) > 0) {
      const { counts } = await runLocationResolve(db, model, RUN_BOUNDS);
      asked.push(counts.asked);
    }
    expect(asked).toEqual([300, 300, 300, 300, 300, 300, 200]);
    expect(await storedStrings()).toBe(BACKLOG + 1);

    // 3. The next digest sees the jobs the run placed near the user, and still not the ones it placed in Dallas.
    const after = await digestRun();
    expect(after.outcomes).toEqual([{ userId, skipped: "no-strong-matches" }]);
    expect(lastCandidates()).toEqual(["resolved", "waiting-0", "waiting-1", "waiting-2"]);

    // Each digest left its record, with how many strings were local to the user at the time.
    const records = await db.select({ counts: digests.counts }).from(digests).orderBy(digests.id);
    expect(records.map((r) => r.counts)).toMatchObject([
      { candidates: 1, localStrings: 1 },
      { candidates: 4, localStrings: 4 },
    ]);
  }, 120_000);
});
