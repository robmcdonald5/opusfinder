import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import { places } from "@opusfinder/db/schema";

import { createTestDb } from "@test/db/pglite";
import { P, seedPlaces } from "@test/db/places";
import { truncate } from "@test/db/truncate";

import { checkAnswers, loadGazetteer, type Gazetteer } from "./check";
import type { AnsweredPlace, LocationAnswerValue } from "./schema";

const city = (name: string, region: string | null, country: string): AnsweredPlace => ({
  city: name,
  region,
  country,
  kind: "city",
});

function answer(placesNamed: AnsweredPlace[], remoteCountries: string[] = []): LocationAnswerValue {
  return { reason: "r", places: placesNamed, remoteCountries, confidence: "high" };
}

describe("the GeoNames check (integration: real PGlite)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;
  let gazetteer: Gazetteer;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedPlaces(db);
    gazetteer = await loadGazetteer(db);
  });
  afterAll(async () => {
    await truncate(db, places);
    await close?.();
  });

  async function check(...answers: LocationAnswerValue[]) {
    return checkAnswers(db, gazetteer, answers);
  }

  it("keeps a place that exists, by region name or code", async () => {
    const [byName, byCode] = await check(
      answer([city("Columbus", "Ohio", "US")]),
      answer([city("Columbus", "GA", "us")]),
    );
    expect(byName).toEqual({ placeIds: [P.COLUMBUS_OH], remoteCountries: [], unmatched: [] });
    expect(byCode!.placeIds).toEqual([P.COLUMBUS_GA]);
  });

  it("drops an unknown city and records why", async () => {
    const [result] = await check(
      answer([city("Atlantis", "Ohio", "US"), city("Westerville", "Ohio", "US")]),
    );
    expect(result!.placeIds).toEqual([P.WESTERVILLE_OH]);
    expect(result!.unmatched).toEqual([
      { city: "Atlantis", region: "Ohio", country: "US", kind: "city", why: "unknown-city" },
    ]);
  });

  it("drops a city placed in the wrong state", async () => {
    const [result] = await check(answer([city("Westerville", "Texas", "US")]));
    expect(result!.placeIds).toEqual([]);
    expect(result!.unmatched[0]!.why).toBe("unknown-city");
  });

  it("takes the larger of two same-named cities in one region", async () => {
    const [result] = await check(answer([city("Fairview", "Ohio", "US")]));
    expect(result!.placeIds).toEqual([P.FAIRVIEW_BIG_OH]);
  });

  it("takes the largest in the country when no region is given, or the region isn't a GeoNames name", async () => {
    const [bare, county] = await check(
      answer([city("Columbus", null, "US")]),
      answer([city("Dublin", "County Dublin", "IE")]),
    );
    expect(bare!.placeIds).toEqual([P.COLUMBUS_OH]);
    expect(county!.placeIds).toEqual([P.DUBLIN_IE]);
  });

  it("matches a city by an alternate name only when no city has that name", async () => {
    const [result] = await check(answer([city("New York", "New York", "US")]));
    expect(result!.placeIds).toEqual([P.NEW_YORK_CITY]);
  });

  it("checks regions, countries and remote countries; drops unknown codes", async () => {
    const [result] = await check(
      answer(
        [
          { city: null, region: "Texas", country: "US", kind: "region" },
          { city: null, region: "Narnia", country: "US", kind: "region" },
          { city: null, region: null, country: "GB", kind: "country" },
          { city: null, region: null, country: "UK", kind: "country" },
        ],
        ["us", "TR", "XX", "US"],
      ),
    );
    expect(result!.placeIds).toEqual([P.TEXAS, P.GB]);
    expect(result!.remoteCountries).toEqual(["US", "TR"]);
    expect(result!.unmatched.map((u) => [u.region ?? u.country, u.why])).toEqual([
      ["Narnia", "unknown-region"],
      ["UK", "unknown-country"],
      ["XX", "unknown-country"],
    ]);
  });

  it("refuses to run against an empty gazetteer", async () => {
    const empty = await createTestDb();
    try {
      await expect(loadGazetteer(empty.db)).rejects.toThrow(/places:load/);
    } finally {
      await empty.close();
    }
  });
});
