import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@opusfinder/db";
import { upsertCompany, upsertJobs, upsertLocationStrings } from "@opusfinder/db/repos";
import { companies, jobs, locationStrings, places } from "@opusfinder/db/schema";
import { companySlug, jobId } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";
import { P, seedPlaces } from "@test/db/places";
import { truncate } from "@test/db/truncate";

import type { LocationAnswer, LocationModel, LocationRequest } from "./model";
import { PROMPT_VERSION } from "./prompt";
import { backfillLocationStrings, syncLocationStrings } from "./resolve";
import type { LocationAnswerValue } from "./schema";

// The daily path backs off between retries; the tests don't wait.
vi.mock("@opusfinder/shared/async", () => ({ backoff: () => Promise.resolve() }));

/** What the stub model answers for a location text. */
const ANSWERS: Record<string, LocationAnswerValue | "refuse" | "garbage"> = {
  "Columbus, OH": {
    reason: "City and state.",
    places: [{ city: "Columbus", region: "Ohio", country: "US", kind: "city" }],
    remoteCountries: [],
    confidence: "high",
  },
  Dublin: {
    reason: "Bare Dublin; the company is in Ohio.",
    places: [{ city: "Dublin", region: "Ohio", country: "US", kind: "city" }],
    remoteCountries: [],
    confidence: "medium",
  },
  "Remote - USA": {
    reason: "Remote in the US.",
    places: [],
    remoteCountries: ["US"],
    confidence: "high",
  },
  Atlantis: {
    reason: "A guess.",
    places: [{ city: "Atlantis", region: null, country: "US", kind: "city" }],
    remoteCountries: [],
    confidence: "low",
  },
  Refused: "refuse",
  Garbled: "garbage",
};

/** The location text a request asks about (its user message's last line). */
function rawOf(request: LocationRequest): string {
  const line = request.user.split("\n").at(-1)!;
  return JSON.parse(line.slice("Location text: ".length)) as string;
}

function answerFor(request: LocationRequest): Exclude<LocationAnswer, { status: "failed" }> {
  const a = ANSWERS[rawOf(request)];
  if (a === undefined) throw new Error(`no stub answer for ${rawOf(request)}`);
  if (a === "refuse") return { status: "no-answer", reason: "refusal" };
  if (a === "garbage") return { status: "answered", text: "{not json" };
  return { status: "answered", text: JSON.stringify(a) };
}

function stubModel(): LocationModel & { requests: LocationRequest[] } {
  const requests: LocationRequest[] = [];
  return {
    requests,
    generate: vi.fn(async (r: LocationRequest) => {
      requests.push(r);
      return answerFor(r);
    }),
    batch: vi.fn(async (rs: LocationRequest[]) => {
      requests.push(...rs);
      return new Map(rs.map((r): [string, LocationAnswer] => [r.id, answerFor(r)]));
    }),
  };
}

describe("resolving location strings (integration: real PGlite, stub model)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;
  let acme: number;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedPlaces(db);
  });
  beforeEach(async () => {
    await truncate(db, companies, jobs, locationStrings);
    acme = await upsertCompany(db, companySlug("acme"), "greenhouse");
    const locations = [
      ["Columbus, OH"],
      ["Columbus, OH", "Dublin"],
      ["Remote - USA"],
      ["Atlantis"],
      ["Refused"],
      ["Garbled"],
    ];
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
  });
  afterAll(async () => {
    await truncate(db, places);
    await close?.();
  });

  async function stored() {
    const rows = await db.select().from(locationStrings);
    return new Map(rows.map((r) => [r.raw, r]));
  }

  it("the daily path stores checked answers, unresolved rows for non-answers, and reports what's left", async () => {
    const model = stubModel();

    const first = await syncLocationStrings(db, model, { limit: 4 });
    expect(first).toEqual({
      resolved: 3,
      unanswered: 1,
      failed: 0,
      unmatchedPlaces: 1,
      more: true,
    });
    const second = await syncLocationStrings(db, model, { limit: 4 });
    // Most-listed first, then by text: the second chunk is "Refused" and "Remote - USA".
    expect(second).toMatchObject({ resolved: 1, unanswered: 1, more: false });
    expect(await syncLocationStrings(db, model, { limit: 4 })).toMatchObject({
      resolved: 0,
      more: false,
    });

    const rows = await stored();
    expect(rows.get("Columbus, OH")).toMatchObject({
      placeIds: [P.COLUMBUS_OH],
      confidence: "high",
      reason: "City and state.",
      promptVersion: PROMPT_VERSION,
    });
    expect(rows.get("Dublin")!.placeIds).toEqual([P.DUBLIN_OH]);
    expect(rows.get("Remote - USA")).toMatchObject({ placeIds: [], remoteCountries: ["US"] });
    expect(rows.get("Atlantis")).toMatchObject({ placeIds: [], confidence: "low" });
    expect(rows.get("Atlantis")!.unmatched).toEqual([
      { city: "Atlantis", region: null, country: "US", kind: "city", why: "unknown-city" },
    ]);
    expect(rows.get("Refused")).toMatchObject({
      confidence: null,
      reason: "not resolved: refusal",
      placeIds: [],
    });
    expect(rows.get("Garbled")).toMatchObject({
      confidence: null,
      reason: "not resolved: the reply was not JSON",
    });
  });

  it("shows the model the company and its OTHER strings, most-listed first", async () => {
    const model = stubModel();
    await syncLocationStrings(db, model, { limit: 10 });
    const dublin = model.requests.find((r) => rawOf(r) === "Dublin")!;
    expect(dublin.user).toContain("Company: acme (greenhouse job board)");
    const others = dublin.user.split("\n").filter((l) => l.startsWith("- "));
    expect(others[0]).toBe('- "Columbus, OH"'); // listed by two jobs
    expect(others).not.toContain('- "Dublin"');
  });

  it("retries a failing request, then throws without storing that chunk", async () => {
    const model = stubModel();
    model.generate = vi.fn(async () => {
      throw new Error("503 from the provider");
    });

    await expect(syncLocationStrings(db, model, { limit: 1 })).rejects.toThrow(/503/);
    expect(model.generate).toHaveBeenCalledTimes(3); // three attempts, then the step fails
    expect((await stored()).size).toBe(0);
  });

  it("the backfill sends one batch over missing, stale and unanswered pairs; a failed request gets no row", async () => {
    await upsertLocationStrings(db, [
      {
        companyId: acme,
        raw: "Columbus, OH",
        placeIds: [P.COLUMBUS_GA],
        remoteCountries: [],
        unmatched: [],
        confidence: "high",
        reason: "old",
        promptVersion: "0",
      },
      {
        companyId: acme,
        raw: "Remote - USA",
        placeIds: [],
        remoteCountries: ["US"],
        unmatched: [],
        confidence: "high",
        reason: "current",
        promptVersion: PROMPT_VERSION,
      },
      {
        companyId: acme,
        raw: "Refused",
        placeIds: [],
        remoteCountries: [],
        unmatched: [],
        confidence: null,
        reason: "not resolved: refusal",
        promptVersion: PROMPT_VERSION,
      },
    ]);
    const model = stubModel();
    const realBatch = model.batch;
    model.batch = vi.fn(async (rs: LocationRequest[]) => {
      const results = await realBatch(rs);
      const dublin = rs.find((r) => rawOf(r) === "Dublin")!;
      results.set(dublin.id, { status: "failed", reason: "expired" });
      return results;
    });

    const { counts, outcomes } = await backfillLocationStrings(db, model);

    expect(model.batch).toHaveBeenCalledTimes(1);
    expect(model.requests.map(rawOf).sort()).toEqual([
      "Atlantis",
      "Columbus, OH",
      "Dublin",
      "Garbled",
      "Refused",
    ]);
    expect(counts).toEqual({ resolved: 2, unanswered: 2, failed: 1, unmatchedPlaces: 1 });
    expect(
      outcomes
        .filter((o) => o.problem)
        .map((o) => [o.pair.raw, o.problem])
        .sort(),
    ).toEqual([
      ["Dublin", "expired"],
      ["Garbled", "the reply was not JSON"],
      ["Refused", "refusal"],
    ]);
    const rows = await stored();
    expect(rows.get("Columbus, OH")).toMatchObject({
      placeIds: [P.COLUMBUS_OH],
      promptVersion: PROMPT_VERSION,
    });
    expect(rows.get("Remote - USA")!.reason).toBe("current"); // up to date: not re-sent
    expect(rows.has("Dublin")).toBe(false);
  });
});
