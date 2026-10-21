import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import { cityKey, findCities, findHomePlace, getPlaces, upsertPlaces } from "@opusfinder/db/repos";
import { resultRows } from "./sql";
import { places } from "@opusfinder/db/schema";

import { createTestDb } from "@test/db/pglite";
import { P, PLACE_ROWS, seedPlaces } from "@test/db/places";
import { truncate } from "@test/db/truncate";

describe("places repo (integration: real PGlite)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedPlaces(db);
  });
  afterAll(async () => {
    await truncate(db, places);
    await close?.();
  });

  it("upserts by geonames_id: a re-run updates in place and never duplicates", async () => {
    const renamed = PLACE_ROWS.map((r) =>
      r.geonamesId === P.WESTERVILLE_OH ? { ...r, population: 40000 } : r,
    );
    await upsertPlaces(db, renamed);
    const rows = await db.select().from(places);
    expect(rows).toHaveLength(PLACE_ROWS.length);
    const [westerville] = await getPlaces(db, [P.WESTERVILLE_OH]);
    expect(westerville!.population).toBe(40000);
  });

  it("leaves a row GeoNames hasn't changed untouched on a re-run", async () => {
    const version = async (id: number) => {
      const result = await db.execute(
        sql`SELECT xmin::text AS v FROM ${places} WHERE geonames_id = ${id}`,
      );
      return (resultRows(result)[0] as { v: string }).v;
    };
    const [columbus, dublin] = [await version(P.COLUMBUS_OH), await version(P.DUBLIN_OH)];

    await upsertPlaces(
      db,
      PLACE_ROWS.map((r) => (r.geonamesId === P.DUBLIN_OH ? { ...r, population: 50000 } : r)),
    );

    expect(await version(P.COLUMBUS_OH)).toBe(columbus);
    expect(await version(P.DUBLIN_OH)).not.toBe(dublin);
  });

  it("finds cities by name within a country, and by alternate name", async () => {
    const matches = await findCities(db, [
      { countryCode: "US", nameNorm: "columbus" },
      { countryCode: "US", nameNorm: "new york" },
      { countryCode: "IE", nameNorm: "dublin" },
    ]);
    const ids = (key: string) =>
      matches.filter((m) => m.key === key).map((m) => [m.geonamesId, m.byAlt]);
    expect(ids(cityKey("US", "columbus")).sort()).toEqual([
      [P.COLUMBUS_GA, false],
      [P.COLUMBUS_OH, false],
    ]);
    expect(ids(cityKey("US", "new york"))).toEqual([[P.NEW_YORK_CITY, true]]);
    expect(ids(cityKey("IE", "dublin"))).toEqual([[P.DUBLIN_IE, false]]);
  });

  describe("findHomePlace", () => {
    it.each([
      ["Columbus, OH", P.COLUMBUS_OH],
      ["Columbus, Ohio", P.COLUMBUS_OH],
      ["columbus, georgia", P.COLUMBUS_GA],
      ["Dublin, Ireland", P.DUBLIN_IE],
      ["Dublin, OH, US", P.DUBLIN_OH],
      ["New York, NY", P.NEW_YORK_CITY],
      ["Westerville", P.WESTERVILLE_OH],
      [String(P.HOUSTON_TX), P.HOUSTON_TX],
    ])("%s → exactly one city", async (text, id) => {
      const found = await findHomePlace(db, text);
      expect("place" in found && found.place.geonamesId).toBe(id);
    });

    it("takes a main-list city over US-dump namesakes, and a dump place only when it is the one", async () => {
      const powhatan = await findHomePlace(db, "Powhatan, Virginia");
      expect("place" in powhatan && powhatan.place.geonamesId).toBe(P.POWHATAN_VA);
      const mchenry = await findHomePlace(db, "McHenry, Mississippi");
      expect("place" in mchenry && mchenry.place.geonamesId).toBe(P.MCHENRY_MS);
      const brooklyn = await findHomePlace(db, "Brooklyn, Georgia");
      expect("candidates" in brooklyn && brooklyn.candidates).toHaveLength(2);
    });

    it("lists the candidates, largest first, when the name is ambiguous", async () => {
      const found = await findHomePlace(db, "London");
      expect("candidates" in found && found.candidates.map((c) => c.geonamesId)).toEqual([
        P.LONDON_GB,
        P.LONDON_OH,
      ]);
    });

    it.each(["Atlantis", "Columbus, TX", String(P.OHIO), "a, b, c, d"])(
      "%s → no city",
      async (text) => {
        const found = await findHomePlace(db, text);
        expect(found).toEqual({ candidates: [] });
      },
    );
  });
});
