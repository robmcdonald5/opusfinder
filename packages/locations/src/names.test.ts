import { describe, expect, it } from "vitest";

import { normalizePlaceName } from "@opusfinder/shared";

import { cityRegionCore, nameVariants, regionCore } from "./names";

const core = (name: string) => regionCore(normalizePlaceName(name));

describe("regionCore", () => {
  it.each([
    // GeoNames' spelling on the left, the posting's on the right: both reduce to the same core.
    ["Ogun State", "Ogun"],
    ["Riyadh Region", "Riyadh Province"],
    ["Haifa", "Haifa District"],
    ["Vilnius", "Vilnius County"],
    ["Bihor County", "Bihor"],
    ["Pohnpei State", "Pohnpei"],
    ["Santiago del Estero", "Santiago del Estero Province"],
    ["Dong Nai", "Đồng Nai Province"],
    ["Gyeonggi", "Gyeonggi-do"],
    ["Mexico", "State of Mexico"],
    ["Kuala Lumpur", "Federal Territory of Kuala Lumpur"],
    ["Almaty", "Almaty Region"],
  ])("%s and %s share a core", (geonames, posting) => {
    expect(core(posting)).toBe(core(geonames));
  });

  it("keeps a name made only of admin words whole, and words that are part of the name", () => {
    expect(core("Autonomous Region")).toBe("autonomous region");
    expect(core("Capital Region")).toBe("capital");
    expect(core("Rio Grande do Sul")).toBe("rio grande do sul");
    expect(core("Mexico City")).toBe("mexico city");
    expect(core("La Libertad")).toBe("la libertad");
  });
});

describe("nameVariants", () => {
  it("spells St./Saint, Mt./Mount and Ft./Fort the other way", () => {
    expect(nameVariants("st joseph")).toEqual(["saint joseph"]);
    expect(nameVariants("saint gallen")).toEqual(["st gallen"]);
    expect(nameVariants("port st lucie")).toEqual(["port saint lucie"]);
    expect(nameVariants("mt pleasant")).toEqual(["mount pleasant"]);
    expect(nameVariants("columbus")).toEqual([]);
  });
});

describe("cityRegionCore", () => {
  it("names the city of a city-region, and nothing for other regions", () => {
    expect(cityRegionCore("kyiv city")).toBe("kyiv");
    expect(cityRegionCore("maputo city")).toBe("maputo");
    expect(cityRegionCore("city of zagreb")).toBe("zagreb");
    expect(cityRegionCore("kyiv oblast")).toBeNull();
    expect(cityRegionCore("mexico")).toBeNull();
  });
});
