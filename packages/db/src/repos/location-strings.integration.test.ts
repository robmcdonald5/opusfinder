import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  coverageBySource,
  listCompanyStrings,
  listPendingPairs,
  pairStatus,
  reportList,
  upsertCompany,
  upsertJobs,
  upsertLocationStrings,
  type LocationStringRow,
} from "@opusfinder/db/repos";
import { companies, jobs, locationStrings, places } from "@opusfinder/db/schema";
import { companySlug, jobId, type SourceName } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";
import { P, seedPlaces } from "@test/db/places";
import { truncate } from "@test/db/truncate";

describe("location_strings repos (integration: real PGlite)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;
  let acme: number;
  let globex: number;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedPlaces(db);
  });
  beforeEach(async () => {
    await truncate(db, companies, jobs, locationStrings);
    acme = await seedJobs("acme", "greenhouse", [
      { key: "a1", locations: ["Columbus, OH", "Remote"] },
      { key: "a2", locations: ["Columbus, OH"] },
      { key: "a3", locations: ["Hybrid", "  "] },
      { key: "a4", locations: ["Remote"], remote: true },
      { key: "a5", locations: ["Closed City"], closed: true },
    ]);
    globex = await seedJobs("globex", "lever", [
      { key: "g1", locations: ["Dublin"] },
      { key: "g2", locations: ["Low Guess"] },
    ]);
  });
  afterAll(async () => {
    await truncate(db, places);
    await close?.();
  });

  async function seedJobs(
    slug: string,
    source: SourceName,
    specs: { key: string; locations: string[]; remote?: boolean; closed?: boolean }[],
  ): Promise<number> {
    const id = await upsertCompany(db, companySlug(slug), source);
    await upsertJobs(
      db,
      id,
      specs.map((s) => ({
        source,
        externalId: jobId(s.key),
        title: s.key,
        companySlug: companySlug(slug),
        locations: s.locations,
        remote: s.remote ?? false,
        descriptionText: `about ${s.key}`,
        applyUrl: `https://example.test/${s.key}`,
        postedAt: null,
      })),
    );
    for (const s of specs.filter((x) => x.closed)) {
      await db
        .update(jobs)
        .set({ lifecycleState: "closed" })
        .where(eq(jobs.externalId, jobId(s.key)));
    }
    return id;
  }

  function row(
    companyId: number,
    raw: string,
    over: Partial<LocationStringRow> = {},
  ): LocationStringRow {
    return {
      companyId,
      raw,
      placeIds: [],
      remoteCountries: [],
      unmatched: [],
      confidence: "high",
      reason: "fixture",
      promptVersion: "1",
      ...over,
    };
  }

  it("lists active, non-blank pairs with no row, most-listed first; skips closed jobs' strings", async () => {
    await upsertLocationStrings(db, [row(acme, "Remote")]);
    const pending = await listPendingPairs(db, { scope: "missing", promptVersion: "1" });
    expect(pending.map((p) => [p.companySlug, p.raw, p.jobs])).toEqual([
      ["acme", "Columbus, OH", 2],
      ["acme", "Hybrid", 1],
      ["globex", "Dublin", 1],
      ["globex", "Low Guess", 1],
    ]);
    expect(pending[0]).toMatchObject({ companyId: acme, companySource: "greenhouse" });
  });

  it("the stale scope adds rows from another prompt version and rows with no answer", async () => {
    await upsertLocationStrings(db, [
      row(acme, "Columbus, OH", { promptVersion: "0" }),
      row(acme, "Hybrid"),
      row(acme, "Remote", { confidence: null, reason: "not resolved: refusal" }),
      row(globex, "Dublin"),
      row(globex, "Low Guess"),
    ]);
    const pending = await listPendingPairs(db, { scope: "stale", promptVersion: "1" });
    expect(pending.map((p) => p.raw)).toEqual(["Columbus, OH", "Remote"]);
    expect(await listPendingPairs(db, { scope: "missing", promptVersion: "1" })).toEqual([]);
  });

  it("upserting replaces a row in place", async () => {
    await upsertLocationStrings(db, [
      row(acme, "Columbus, OH", { placeIds: [P.COLUMBUS_GA], confidence: "low" }),
    ]);
    await upsertLocationStrings(db, [row(acme, "Columbus, OH", { placeIds: [P.COLUMBUS_OH] })]);
    const stored = await db.select().from(locationStrings);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ placeIds: [P.COLUMBUS_OH], confidence: "high" });
  });

  it("lists each company's strings, most-listed first, capped per company", async () => {
    const strings = await listCompanyStrings(db, [acme, globex], 2);
    expect(strings.get(acme)).toEqual(["Columbus, OH", "Remote"]);
    expect(strings.get(globex)).toEqual(["Dublin", "Low Guess"]);
  });

  it("reports coverage by source, pair status and the worklists", async () => {
    await upsertLocationStrings(db, [
      row(acme, "Columbus, OH", { placeIds: [P.COLUMBUS_OH] }),
      row(acme, "Hybrid"),
      row(acme, "Remote", { promptVersion: "0" }),
      row(globex, "Dublin", {
        unmatched: [
          {
            city: "Dublin",
            region: "Atlantis",
            country: "XX",
            kind: "city",
            why: "unknown-country",
          },
        ],
      }),
      row(globex, "Low Guess", { confidence: "low", placeIds: [P.DUBLIN_IE] }),
    ]);

    expect(await coverageBySource(db)).toEqual([
      { source: "greenhouse", onsite: 3, onsitePlaced: 2, remote: 1 },
      { source: "lever", onsite: 2, onsitePlaced: 1, remote: 0 },
    ]);
    expect(await pairStatus(db, "1")).toEqual({ active: 5, missing: 0, stale: 1, unresolved: 0 });
    // By active jobs, then company slug.
    expect((await reportList(db, "no-place", 10)).map((r) => r.raw)).toEqual([
      "Remote",
      "Hybrid",
      "Dublin",
    ]);
    expect((await reportList(db, "low-confidence", 10)).map((r) => r.raw)).toEqual(["Low Guess"]);
    const unmatched = await reportList(db, "unmatched", 10);
    expect(unmatched).toEqual([
      expect.objectContaining({ companySlug: "globex", raw: "Dublin", jobs: 1 }),
    ]);
    expect(unmatched[0]!.unmatched[0]).toMatchObject({ why: "unknown-country" });
  });
});
