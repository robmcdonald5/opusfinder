import { describe, expect, it } from "vitest";

import { AREA_NAMES, AREAS, areaCountries, readArea } from "./areas";

describe("areas", () => {
  it("lists every area as distinct ISO 3166-1 alpha-2 codes", () => {
    for (const name of AREA_NAMES) {
      const codes = AREAS[name];
      expect(codes.length, name).toBeGreaterThan(0);
      expect(
        codes.every((c) => /^[A-Z]{2}$/.test(c)),
        name,
      ).toBe(true);
      expect(new Set(codes).size, name).toBe(codes.length);
    }
  });

  it("builds the blocs from their parts", () => {
    const has = (area: keyof typeof AREAS, codes: string[]) =>
      codes.every((c) => (AREAS[area] as readonly string[]).includes(c));
    expect(has("EMEA", [...AREAS.Europe, ...AREAS["Middle East"], ...AREAS.Africa])).toBe(true);
    expect(has("Europe", [...AREAS["European Union"], ...AREAS.DACH, ...AREAS.Benelux])).toBe(true);
    expect(AREAS.Nordics.filter((c) => !AREAS.Europe.includes(c))).toEqual(["GL"]); // M49: Northern America
    expect(has("Americas", [...AREAS["Latin America"], ...AREAS["North America"]])).toBe(true);
    expect(has("Latin America", [...AREAS["Central America"], ...AREAS["South America"]])).toBe(
      true,
    );
    expect(
      has(
        "Asia",
        AREAS.APAC.filter((c) => !AREAS.Oceania.includes(c)),
      ),
    ).toBe(true);
    expect(AREAS.APAC).not.toContain("IR");
    expect(AREAS["North America"]).not.toContain("MX");
    expect(AREAS["European Union"]).toHaveLength(27);
    expect(has("MENA", [...AREAS["Middle East"], "DZ", "EG", "LY", "MA", "SD", "TN", "EH"])).toBe(
      true,
    );
    expect(
      has("Asia", [...AREAS["East Asia"], ...AREAS["Southeast Asia"], ...AREAS["South Asia"]]),
    ).toBe(true);
    expect(has("Europe", [...AREAS["Northern Europe"], ...AREAS["Southern Europe"]])).toBe(true);
  });

  it("opens a region of the United States to the United States", () => {
    for (const name of [
      "US Northeast",
      "US Midwest",
      "US West Coast",
      "New England",
      "Mid-Atlantic",
    ]) {
      expect(areaCountries(name), name).toEqual(["US"]);
    }
    expect(readArea("Midwest")).toBe("US Midwest");
    // Bare labels that mean other things elsewhere are not aliased.
    expect(readArea("West Coast")).toBeNull();
    expect(readArea("Central")).toBeNull();
  });

  it("reads a label by the list's name or an alias, and knows the labels that set no limit", () => {
    expect(readArea("LATAM")).toBe("Latin America");
    expect(readArea("apj")).toBe("APAC");
    expect(readArea("Asia-Pacific")).toBe("APAC");
    expect(readArea("Middle East & North Africa")).toBe("MENA");
    expect(readArea("South East Asia")).toBe("Southeast Asia");
    expect(readArea("Northeast Asia")).toBe("East Asia");
    expect(readArea("the Nordics")).toBeNull();
    expect(readArea("Worldwide")).toBe("no-limit");
    expect(areaCountries("Global")).toEqual([]);
    expect(areaCountries("DACH")).toEqual(["DE", "AT", "CH"]);
    expect(areaCountries("Atlantic Rim")).toBeNull();
  });
});
