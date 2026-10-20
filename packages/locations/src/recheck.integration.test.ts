import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  listUnmatchedLocationStrings,
  updateCheckedPlaces,
  upsertCompany,
  upsertLocationStrings,
} from "@opusfinder/db/repos";
import { companies, locationStrings, places } from "@opusfinder/db/schema";
import { companySlug, type UnmatchedPlace } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";
import { P, seedPlaces } from "@test/db/places";
import { truncate } from "@test/db/truncate";

import { PROMPT_VERSION } from "./prompt";
import { recheckLocationStrings } from "./recheck";

const failedCity = (city: string, region: string, regionCode: string | null): UnmatchedPlace => ({
  kind: "city",
  city,
  region,
  country: "US",
  why: "unknown-city",
  countryCode: "US",
  regionCode,
});

describe("locations:recheck (integration: real PGlite)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;
  let acme: number;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedPlaces(db);
  });
  beforeEach(async () => {
    await truncate(db, companies, locationStrings);
    acme = await upsertCompany(db, companySlug("acme"), "greenhouse");
    const row = (
      raw: string,
      unmatched: UnmatchedPlace[],
      placeIds: number[] = [],
      promptVersion = PROMPT_VERSION,
    ) => ({
      companyId: acme,
      raw,
      placeIds,
      remoteCountries: [],
      unmatched,
      confidence: "medium" as const,
      reason: "the model's reading",
      promptVersion,
    });
    await upsertLocationStrings(db, [
      // A town the gazetteer has now, next to a city that passed the first time.
      row(
        "Huntsville; McHenry, Mississippi",
        [failedCity("McHenry", "Mississippi", "MS")],
        [P.COLUMBUS_OH],
      ),
      // A bloc the area list knows now (by its alias), and a code that will never be a country.
      row("Remote - South East Asia", [
        { kind: "area", name: "South East Asia", why: "unknown-area" },
        {
          kind: "country",
          city: null,
          region: null,
          country: "XX",
          why: "unknown-country",
          countryCode: null,
          regionCode: null,
        },
      ]),
      row("Atlantis, Ohio", [failedCity("Atlantis", "Ohio", "OH")]),
      // An older prompt version's answer: read under older rules, left for the backfill.
      row(
        "Old answer: McHenry, Mississippi",
        [failedCity("McHenry", "Mississippi", "MS")],
        [],
        "0",
      ),
    ]);
  });
  afterAll(async () => {
    await truncate(db, places);
    await close?.();
  });

  async function stored() {
    return new Map((await db.select().from(locationStrings)).map((r) => [r.raw, r]));
  }

  it("moves what now passes into the row and leaves the rest, keeping the model's answer", async () => {
    const result = await recheckLocationStrings(db);

    expect(result).toMatchObject({
      rows: 3,
      changed: 2,
      written: 2,
      recovered: 2,
      stillUnmatched: 2,
    });
    const rows = await stored();
    expect(rows.get("Huntsville; McHenry, Mississippi")).toMatchObject({
      placeIds: [P.COLUMBUS_OH, P.MCHENRY_MS],
      unmatched: [],
      confidence: "medium",
      reason: "the model's reading",
      promptVersion: PROMPT_VERSION,
    });
    const sea = rows.get("Remote - South East Asia")!;
    expect(sea.remoteCountries).toEqual(["MY"]); // the fixture gazetteer's South-East Asian country
    expect(sea.unmatched).toEqual([expect.objectContaining({ why: "unknown-country" })]);
    expect(rows.get("Atlantis, Ohio")!.unmatched).toHaveLength(1);
    expect(rows.get("Old answer: McHenry, Mississippi")).toMatchObject({ placeIds: [] });
  });

  it("leaves a row alone that something else rewrote since it was read", async () => {
    const [read] = (await listUnmatchedLocationStrings(db, PROMPT_VERSION)).filter(
      (r) => r.raw === "Atlantis, Ohio",
    );
    // A backfill answers the row between the recheck's read and its write.
    await upsertLocationStrings(db, [
      {
        ...read!,
        unmatched: [],
        placeIds: [P.COLUMBUS_OH],
        confidence: "high",
        reason: "a newer answer",
      },
    ]);

    const written = await updateCheckedPlaces(db, [
      { ...read!, placeIds: [], unmatched: [], previousUnmatched: read!.unmatched },
    ]);

    expect(written).toBe(0);
    expect((await stored()).get("Atlantis, Ohio")).toMatchObject({
      placeIds: [P.COLUMBUS_OH],
      reason: "a newer answer",
    });
  });

  it("writes nothing on a dry run", async () => {
    const before = await stored();
    const result = await recheckLocationStrings(db, { dryRun: true });

    expect(result.changed).toBe(2);
    expect(await stored()).toEqual(before);
  });
});
