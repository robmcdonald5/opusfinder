import { describe, expect, it } from "vitest";

import { parseAdmin1, parseCities, parseCountries, parsePopulatedPlaces } from "./geonames";

/** A cities500 line: the 19 tab-separated GeoNames fields, defaults for the ones a case doesn't vary. */
function cityLine(
  over: Partial<
    Record<
      "id" | "name" | "ascii" | "alts" | "lat" | "lng" | "code" | "cc" | "admin1" | "pop",
      string
    >
  > = {},
): string {
  const f = {
    id: "4509177",
    name: "Columbus",
    ascii: "Columbus",
    alts: "CMH,Columbus i Ohio,Колумбус",
    lat: "39.96118",
    lng: "-82.99879",
    code: "PPLA",
    cc: "US",
    admin1: "OH",
    pop: "913175",
    ...over,
  };
  return [
    f.id,
    f.name,
    f.ascii,
    f.alts,
    f.lat,
    f.lng,
    "P",
    f.code,
    f.cc,
    "",
    f.admin1,
    "049",
    "",
    "",
    f.pop,
    "",
    "237",
    "America/New_York",
    "2024-01-01",
  ].join("\t");
}

const REGIONS = new Map([["US.OH", "Ohio"]]);

describe("parseCities", () => {
  it("parses a city, its region name, coordinates and normalized names", () => {
    const { rows, skipped } = parseCities(cityLine(), REGIONS);
    expect(skipped).toBe(0);
    expect(rows).toEqual([
      {
        geonamesId: 4509177,
        kind: "city",
        name: "Columbus",
        nameNorm: "columbus",
        asciiNorm: "columbus",
        // Latin-script alternates only, normalized; the Cyrillic one is dropped.
        altNames: ["cmh", "columbus i ohio"],
        regionCode: "OH",
        regionName: "Ohio",
        countryCode: "US",
        lat: 39.96118,
        lng: -82.99879,
        population: 913175,
        source: "main",
      },
    ]);
  });

  it("keeps the accented name and the ASCII name as separate keys", () => {
    const [row] = parseCities(
      cityLine({ name: "Zürich", ascii: "Zuerich", cc: "CH", admin1: "ZH", alts: "" }),
      new Map(),
    ).rows;
    expect(row).toMatchObject({
      nameNorm: "zurich",
      asciiNorm: "zuerich",
      regionCode: "ZH",
      regionName: null,
    });
  });

  it("treats admin1 '00' and '' as no region", () => {
    const { rows } = parseCities(
      [cityLine({ admin1: "00" }), cityLine({ id: "2", admin1: "" })].join("\n"),
      REGIONS,
    );
    expect(rows.map((r) => r.regionCode)).toEqual([null, null]);
  });

  it("skips historical, abandoned and destroyed places without counting them as malformed", () => {
    const { rows, skipped } = parseCities(
      ["PPLH", "PPLQ", "PPLW", "PPLCH"].map((code) => cityLine({ code })).join("\n"),
      REGIONS,
    );
    expect(rows).toEqual([]);
    expect(skipped).toBe(0);
  });

  it.each([
    ["a non-numeric id", { id: "12a" }],
    ["a latitude out of range", { lat: "91.5" }],
    ["a non-numeric longitude", { lng: "east" }],
    ["a three-letter country", { cc: "USA" }],
    ["a negative population", { pop: "-3" }],
    ["an empty name", { name: "" }],
    ["a control character in the name", { name: `Colum${String.fromCharCode(7)}bus` }],
    ["an admin1 code with punctuation", { admin1: "O;H" }],
  ])("skips and counts a line with %s", (_label, over) => {
    const { rows, skipped } = parseCities(cityLine(over), REGIONS);
    expect(rows).toEqual([]);
    expect(skipped).toBe(1);
  });

  it("skips a line with the wrong number of fields, tolerating CRLF and blank lines", () => {
    const { rows, skipped } = parseCities(`${cityLine()}\r\n\r\nonly\tthree\tfields\r\n`, REGIONS);
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(1);
  });
});

describe("parseAdmin1", () => {
  it("parses regions and returns the CC.code → name map", () => {
    const { rows, names, skipped } = parseAdmin1(
      "US.OH\tOhio\tOhio\t5165418\nFR.11\tÎle-de-France\tIle-de-France\t3012874\n",
    );
    expect(skipped).toBe(0);
    expect(names.get("FR.11")).toBe("Île-de-France");
    expect(rows[1]).toMatchObject({
      geonamesId: 3012874,
      kind: "region",
      nameNorm: "ile de france",
      regionCode: "11",
      countryCode: "FR",
      lat: null,
      source: "main",
    });
  });

  it("skips a malformed key, id or extra field", () => {
    const { rows, skipped } = parseAdmin1(
      "USOH\tOhio\tOhio\t1\nUS.OH\tOhio\tOhio\tx\nUS.OH\tOhio\tOhio\t1\textra\n",
    );
    expect(rows).toEqual([]);
    expect(skipped).toBe(3);
  });
});

describe("parseCountries", () => {
  const header =
    "#ISO\tISO3\tISO-Numeric\tfips\tCountry\tCapital\tArea\tPopulation\tContinent\ttld\tCurrencyCode\tCurrencyName\tPhone\tPostal\tRegex\tLanguages\tgeonameid\tneighbours\tEquivalentFipsCode";
  const line = (iso: string, name: string, pop: string, id: string) =>
    [
      iso,
      "XXX",
      "000",
      "XX",
      name,
      "Cap",
      "1",
      pop,
      "EU",
      ".xx",
      "EUR",
      "Euro",
      "1",
      "",
      "",
      "en",
      id,
      "",
      "",
    ].join("\t");

  it("parses countries and skips comment lines", () => {
    const { rows, skipped } = parseCountries(
      `${header}\n${line("GB", "United Kingdom", "68138484", "2635167")}\n`,
    );
    expect(skipped).toBe(0);
    expect(rows).toEqual([
      expect.objectContaining({
        geonamesId: 2635167,
        kind: "country",
        name: "United Kingdom",
        countryCode: "GB",
        population: 68138484,
        source: "main",
      }),
    ]);
  });

  it("skips a dissolved country GeoNames lists without a geonameid", () => {
    const { rows, skipped } = parseCountries(line("AN", "Netherlands Antilles", "300000", ""));
    expect(rows).toEqual([]);
    expect(skipped).toBe(1);
  });
});

describe("parsePopulatedPlaces", () => {
  /** A US.txt line: a cities500 line with its feature class and code set. */
  const featureLine = (id: string, name: string, cls: string, code: string, pop = "0") =>
    cityLine({ id, name, ascii: name, alts: "", code, pop }).replace("\tP\t", `\t${cls}\t`);

  it("keeps populated places of any population and skips every other feature class", () => {
    const text = [
      featureLine("4435457", "McHenry", "P", "PPL"),
      featureLine("4366327", "Quantico", "P", "PPL", "133"),
      featureLine("5102430", "Township of Parsippany-Troy Hills", "A", "ADM3"),
      featureLine("4436000", "McHenry Creek", "H", "STM"),
      featureLine("4400000", "Old Town", "P", "PPLQ"),
    ].join("\r\n");

    const { rows, skipped } = parsePopulatedPlaces(new TextEncoder().encode(text), REGIONS);

    expect(skipped).toBe(0);
    expect(rows.map((r) => [r.geonamesId, r.name, r.population, r.source])).toEqual([
      [4435457, "McHenry", 0, "us-dump"],
      [4366327, "Quantico", 133, "us-dump"],
    ]);
  });

  it("counts a malformed populated-place line as skipped", () => {
    const text = [
      featureLine("x1", "Broken", "P", "PPL"),
      featureLine("1", "Fine", "P", "PPL"),
    ].join("\n");
    expect(parsePopulatedPlaces(new TextEncoder().encode(text), REGIONS)).toMatchObject({
      skipped: 1,
      rows: [expect.objectContaining({ name: "Fine" })],
    });
  });
});
