import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import { places } from "@opusfinder/db/schema";

import { createTestDb } from "@test/db/pglite";
import { P, seedPlaces } from "@test/db/places";
import { truncate } from "@test/db/truncate";

import { checkAnswers, describeUnmatched, loadGazetteer, type Gazetteer } from "./check";
import type { AnsweredPlace, LocationAnswerValue } from "./schema";

const city = (name: string, region: string | null, country: string): AnsweredPlace => ({
  city: name,
  region,
  country,
  kind: "city",
});

function answer(
  placesNamed: AnsweredPlace[],
  remoteCountries: string[] = [],
  areas: string[] = [],
): LocationAnswerValue {
  return { reason: "r", places: placesNamed, remoteCountries, areas, confidence: "high" };
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

  it("drops an unknown city and records why, with the country and region codes that did check", async () => {
    const [result] = await check(
      answer([
        city("Atlantis", "Ohio", "US"),
        city("Westerville", "Ohio", "US"),
        city("Smallville", "Kansas", "US"),
        city("Gotham", null, "XX"),
      ]),
    );
    expect(result!.placeIds).toEqual([P.WESTERVILLE_OH]);
    expect(result!.unmatched).toEqual([
      {
        kind: "city",
        city: "Atlantis",
        region: "Ohio",
        country: "US",
        why: "unknown-city",
        countryCode: "US",
        regionCode: "OH",
      },
      {
        kind: "city",
        city: "Smallville",
        region: "Kansas", // not in the fixture gazetteer: no region code
        country: "US",
        why: "unknown-city",
        countryCode: "US",
        regionCode: null,
      },
      {
        kind: "city",
        city: "Gotham",
        region: null,
        country: "XX",
        why: "unknown-country",
        countryCode: null,
        regionCode: null,
      },
    ]);
  });

  it("drops a city placed in the wrong state", async () => {
    const [result] = await check(answer([city("Westerville", "Texas", "US")]));
    expect(result!.placeIds).toEqual([]);
    expect(result!.unmatched[0]).toMatchObject({ why: "unknown-city", regionCode: "TX" });
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

  it("looks a city up across the country when its region is named exactly like it", async () => {
    // GeoNames can file a city under a region other than its namesake municipality (Taipei sits under
    // Taiwan's legacy "Taiwan" admin1, not "Taipei"); a region named like the city means the city itself.
    const [namesake, wrongState] = await check(
      answer([city("Taipei", "Taipei", "TW")]),
      answer([city("Westerville", "Texas", "US")]),
    );
    expect(namesake!.placeIds).toEqual([P.TAIPEI]);
    expect(wrongState!.placeIds).toEqual([]);
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
    expect(result!.unmatched.map(describeUnmatched)).toEqual([
      "Narnia, US (unknown-region)",
      "UK (unknown-country)",
      "XX (unknown-country)",
    ]);
  });

  it("expands areas on the list into their countries, and keeps one off the list as unmatched", async () => {
    const [europe, mixed, noLimit] = await check(
      answer([], [], ["Europe"]),
      answer([], ["US"], ["LATAM", "Middle East", "Atlantic Rim"]),
      answer([], [], ["Worldwide"]),
    );
    // The fixture gazetteer's countries in M49 Europe; codes it lacks are dropped.
    expect(europe!.remoteCountries.sort()).toEqual(["AT", "CH", "DE", "FR", "GB", "IE"]);
    expect(europe!.unmatched).toEqual([]);
    expect(mixed!.remoteCountries.sort()).toEqual(["PE", "TR", "US"]); // LATAM: Peru in the fixture
    expect(mixed!.unmatched).toEqual([{ kind: "area", name: "Atlantic Rim", why: "unknown-area" }]);
    expect(noLimit).toEqual({ placeIds: [], remoteCountries: [], unmatched: [] });
  });

  it("reads a region by its name without the words that only say it is a region", async () => {
    const region = (name: string, country: string): AnsweredPlace => ({
      city: null,
      region: name,
      country,
      kind: "region",
    });
    const [ogun, salzburgState, ambiguous] = await check(
      answer([region("Ogun", "NG")]),
      answer([region("Salzburg State", "AT")]),
      // "Almaty Region" and "Almaty" both reduce to "almaty": no guess between them.
      answer([region("Almaty Oblysy", "KZ")]),
    );
    expect(ogun!.placeIds).toEqual([P.OGUN_STATE]);
    expect(salzburgState!.placeIds).toEqual([P.SALZBURG]);
    expect(ambiguous!.unmatched[0]).toMatchObject({ why: "unknown-region" });
  });

  it("treats a region named like the city, admin words aside, as the city's own municipality", async () => {
    const [almaty, lima, kl] = await check(
      answer([city("Almaty", "Almaty Region", "KZ")]),
      answer([city("Lima", "Lima Region", "PE")]),
      // Not a namesake: Kuala Lumpur is a federal territory, not part of Selangor (the prompt's job).
      answer([city("Kuala Lumpur", "Selangor", "MY")]),
    );
    expect(almaty!.placeIds).toEqual([P.ALMATY]);
    expect(lima!.placeIds).toEqual([P.LIMA]);
    expect(kl!.unmatched[0]).toMatchObject({ why: "unknown-city", regionCode: "12" });
  });

  it("matches St./Saint either way, in a city and in a region", async () => {
    const [stJoseph, stGallen] = await check(
      answer([city("St. Joseph", "Michigan", "US")]),
      answer([city("Rapperswil", "St. Gallen", "CH")]),
    );
    expect(stJoseph!.placeIds).toEqual([P.SAINT_JOSEPH_MI]);
    expect(stGallen!.placeIds).toEqual([P.RAPPERSWIL]);
  });

  it("matches a hyphenated compound by a part, only inside a region it knows", async () => {
    const [wals, rapperswil, noRegion] = await check(
      answer([city("Wals-Siezenheim", "Salzburg", "AT")]),
      answer([city("Rapperswil-Jona", "St. Gallen", "CH")]),
      answer([city("Wals-Siezenheim", null, "AT")]),
    );
    expect(wals!.placeIds).toEqual([P.WALS]);
    expect(rapperswil!.placeIds).toEqual([P.RAPPERSWIL]);
    expect(noRegion!.placeIds).toEqual([]);
  });

  it("keeps a small town in the state named, never its larger namesake elsewhere", async () => {
    const [mississippi, bare] = await check(
      answer([city("McHenry", "Mississippi", "US")]),
      answer([city("McHenry", null, "US")]),
    );
    expect(mississippi!.placeIds).toEqual([P.MCHENRY_MS]);
    expect(bare!.placeIds).toEqual([P.MCHENRY_IL]); // no state: the largest McHenry
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
