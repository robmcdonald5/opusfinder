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
import {
  backfillLocationStrings,
  collectLocationBatch,
  requestId,
  syncLocationStrings,
} from "./resolve";
import type { LocationAnswerValue } from "./schema";

// Two requests per batch, so a handful of pairs makes several batches.
vi.mock("./model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model")>()),
  BATCH_SIZE: 2,
}));

const answer = (a: Omit<LocationAnswerValue, "areas"> & { areas?: string[] }) => ({
  areas: [],
  ...a,
});

/** What the stub model answers for a location text. */
const ANSWERS: Record<string, LocationAnswerValue | "refuse" | "garbage"> = {
  "Columbus, OH": answer({
    reason: "City and state.",
    places: [{ city: "Columbus", region: "Ohio", country: "US", kind: "city" }],
    remoteCountries: [],
    confidence: "high",
  }),
  Dublin: answer({
    reason: "Bare Dublin; the company is in Ohio.",
    places: [{ city: "Dublin", region: "Ohio", country: "US", kind: "city" }],
    remoteCountries: [],
    confidence: "medium",
  }),
  "Remote - USA": answer({
    reason: "Remote in the US.",
    places: [],
    remoteCountries: ["US"],
    confidence: "high",
  }),
  Atlantis: answer({
    reason: "A guess.",
    places: [{ city: "Atlantis", region: null, country: "US", kind: "city" }],
    remoteCountries: [],
    confidence: "low",
  }),
  Refused: "refuse",
  Garbled: "garbage",
};

/** The location text a request asks about (its user message's last line). */
function rawOf(request: LocationRequest): string {
  const line = request.user.split("\n").at(-1)!;
  return JSON.parse(line.slice("Location text: ".length)) as string;
}

function answerFor(request: LocationRequest): LocationAnswer {
  const a = ANSWERS[rawOf(request)];
  if (a === undefined) throw new Error(`no stub answer for ${rawOf(request)}`);
  if (a === "refuse") return { status: "no-answer", reason: "refusal" };
  if (a === "garbage") return { status: "answered", text: "{not json" };
  return { status: "answered", text: JSON.stringify(a) };
}

const TRANSIENT: LocationAnswer = { status: "failed", reason: "OpenRouter 503 error" };

function stubModel(): LocationModel & { requests: LocationRequest[] } {
  const requests: LocationRequest[] = [];
  const batches = new Map<string, LocationRequest[]>();
  return {
    requests,
    generate: vi.fn(async (r: LocationRequest) => {
      requests.push(r);
      return answerFor(r);
    }),
    submitBatch: vi.fn(async (rs: LocationRequest[]) => {
      requests.push(...rs);
      const id = `batch_${batches.size}`;
      batches.set(id, rs);
      return id;
    }),
    collectBatch: vi.fn(
      async (id: string) =>
        new Map(batches.get(id)!.map((r): [string, LocationAnswer] => [r.id, answerFor(r)])),
    ),
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

  it("the daily path stores checked answers and deterministic non-answers, and asks for neither again", async () => {
    const model = stubModel();

    const first = await syncLocationStrings(db, model, { limit: 4 });
    expect(first).toEqual({
      resolved: 3,
      unanswered: 1,
      failed: 0,
      unmatchedPlaces: 1,
      more: true,
      failedPairs: [],
    });
    const second = await syncLocationStrings(db, model, { limit: 4 });
    // Most-listed first, then by text: the second chunk is "Refused" and "Remote - USA".
    expect(second).toMatchObject({ resolved: 1, unanswered: 1, more: false });
    expect(await syncLocationStrings(db, model, { limit: 4 })).toMatchObject({
      resolved: 0,
      more: false,
    });
    expect(model.requests).toHaveLength(6);

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
      {
        kind: "city",
        city: "Atlantis",
        region: null,
        country: "US",
        why: "unknown-city",
        countryCode: "US",
        regionCode: null,
      },
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

  it("stores nothing for a transient failure, hands it back to skip for the rest of the run, and asks again next run", async () => {
    const model = stubModel();
    const real = model.generate;
    model.generate = vi.fn(async (r: LocationRequest) =>
      rawOf(r) === "Atlantis" ? TRANSIENT : real(r),
    );

    const first = await syncLocationStrings(db, model, { limit: 3 });
    expect(first).toMatchObject({
      resolved: 2,
      failed: 1,
      more: true,
      failedPairs: [{ companyId: acme, raw: "Atlantis" }],
    });
    expect((await stored()).has("Atlantis")).toBe(false);

    const rest = await syncLocationStrings(db, model, { limit: 10, exclude: first.failedPairs });
    expect(rest).toMatchObject({ failed: 0, more: false });
    expect(model.requests.filter((r) => rawOf(r) === "Atlantis")).toHaveLength(0);

    model.generate = real; // the next run
    expect(await syncLocationStrings(db, model, { limit: 10 })).toMatchObject({ resolved: 1 });
    expect((await stored()).get("Atlantis")!.confidence).toBe("low");
  });

  it("throws, storing nothing, when every request of a call fails transiently", async () => {
    const model = stubModel();
    model.generate = vi.fn(async () => TRANSIENT);

    await expect(syncLocationStrings(db, model, { limit: 3 })).rejects.toThrow(
      /unavailable: all 3 requests failed \(OpenRouter 503 error\)/,
    );
    expect((await stored()).size).toBe(0);
  });

  it("does not take one or two failing pairs for an outage", async () => {
    const model = stubModel();
    model.generate = vi.fn(async () => TRANSIENT);

    const result = await syncLocationStrings(db, model, { limit: 2 });

    expect(result).toMatchObject({ resolved: 0, failed: 2 });
    expect(result.failedPairs).toHaveLength(2);
  });

  it("stores each answer as it comes back, so a call cut off part-way keeps the finished ones", async () => {
    const model = stubModel();
    const real = model.generate;
    model.generate = vi.fn(async (r: LocationRequest) => {
      if (rawOf(r) !== "Dublin") return real(r);
      // Wait for the other two pairs' rows, then die the way a step killed at its time limit would.
      for (let i = 0; i < 200 && (await stored()).size < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("the step ran out of time");
    });

    await expect(syncLocationStrings(db, model, { limit: 3 })).rejects.toThrow(/out of time/);

    expect([...(await stored()).keys()].sort()).toEqual(["Atlantis", "Columbus, OH"]);
  });

  it("the backfill batches missing, stale and unanswered pairs and stores each batch as it ends", async () => {
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
    const realCollect = model.collectBatch;
    model.collectBatch = vi.fn(async (id: string) => {
      const results = await realCollect(id);
      for (const [rid, a] of results) {
        if (a.status === "answered" && a.text.includes("Bare Dublin")) results.set(rid, TRANSIENT);
      }
      return results;
    });
    const submitted: string[] = [];

    const { counts, outcomes, batches } = await backfillLocationStrings(db, model, {
      onSubmitted: (id) => submitted.push(id),
    });

    expect(submitted).toEqual(["batch_0", "batch_1", "batch_2"]); // 5 pairs, 2 per batch
    expect(batches.every((b) => !b.error)).toBe(true);
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
      ["Dublin", "OpenRouter 503 error"],
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

  it("a batch that fails to submit or to end costs only its own pairs", async () => {
    const model = stubModel();
    const realSubmit = model.submitBatch;
    const realCollect = model.collectBatch;
    let submits = 0;
    model.submitBatch = vi.fn(async (rs: LocationRequest[]) => {
      if (submits++ === 2) throw new Error("OpenRouter 502 error");
      return realSubmit(rs);
    });
    model.collectBatch = vi.fn(async (id: string) => {
      if (id === "batch_0") throw new Error("collectBatchResults: batch batch_0 is expired");
      return realCollect(id);
    });

    const { batches } = await backfillLocationStrings(db, model);

    expect(batches).toEqual([
      { batchId: "batch_0", pairs: 2, error: expect.stringMatching(/expired/) },
      { batchId: "batch_1", pairs: 2 },
      { batchId: null, pairs: 2, error: "Error: OpenRouter 502 error" },
    ]);
    // Six pending pairs, most-listed first: batch_1 (the 3rd and 4th) is the one stored.
    expect([...(await stored()).keys()].sort()).toEqual(["Dublin", "Garbled"]);
  });

  it("collects a batch an earlier run submitted, without sending anything", async () => {
    const model = stubModel();
    const realCollect = model.collectBatch;
    model.collectBatch = vi.fn(async () => {
      throw new Error("the process died while waiting");
    });
    const { batches } = await backfillLocationStrings(db, model);
    expect((await stored()).size).toBe(0);

    // A pair resolved since: its answer in the batch is not stored over the newer row.
    await upsertLocationStrings(db, [
      {
        companyId: acme,
        raw: "Columbus, OH",
        placeIds: [P.COLUMBUS_OH],
        remoteCountries: [],
        unmatched: [],
        confidence: "high",
        reason: "resolved since",
        promptVersion: PROMPT_VERSION,
      },
    ]);
    model.collectBatch = realCollect;
    vi.mocked(model.submitBatch).mockClear();

    const result = await collectLocationBatch(db, model, batches[0]!.batchId!);

    expect(model.submitBatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ counts: { resolved: 1 }, skipped: 1 });
    const rows = await stored();
    expect(rows.get("Columbus, OH")!.reason).toBe("resolved since");
    expect(rows.get("Atlantis")!.confidence).toBe("low");
  });

  it("names each request by its pair and prompt version, within the Batch API's id pattern", () => {
    const id = requestId({ companyId: 123456, raw: "Columbus, OH ".repeat(100) });
    expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(id.startsWith(`v${PROMPT_VERSION}-123456-`)).toBe(true);
    expect(requestId({ companyId: 1, raw: "a" })).not.toBe(requestId({ companyId: 1, raw: "b" }));
  });
});
