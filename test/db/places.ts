import type { Db } from "@opusfinder/db";
import type { PlaceRow } from "@opusfinder/db/geonames";
import { upsertPlaces } from "@opusfinder/db/repos";
import { normalizePlaceName, type PlaceKind } from "@opusfinder/shared";

/**
 * A small gazetteer for the location suites: real GeoNames ids, names and coordinates for the places the
 * cases need, plus synthetic towns (ids 9000xx) where a case needs an exact geometry or a same-name pair.
 * One degree of latitude is 2π·3958.8/360 ≈ 69.0934 miles, so a town 0.71643° due north of Columbus is
 * 49.5 miles away and one 0.73090° north is 50.5.
 */
export const P = {
  US: 6252001,
  GB: 2635167,
  IE: 2963597,
  TR: 298795,
  TW: 1668284,
  TAIPEI_REGION: 7280290,
  TAIWAN_REGION: 7280291,
  TAIPEI: 1668341,
  OHIO: 5165418,
  TEXAS: 4736286,
  NEW_YORK_STATE: 5128638,
  GEORGIA_STATE: 4197000,
  ENGLAND: 6269131,
  LEINSTER: 7521314,
  COLUMBUS_OH: 4509177,
  WESTERVILLE_OH: 5176472,
  DUBLIN_OH: 5152333,
  LONDON_OH: 4517009,
  CINCINNATI_OH: 4508722,
  COLUMBUS_GA: 4188985,
  DALLAS_TX: 4684888,
  HOUSTON_TX: 4699066,
  NEW_YORK_CITY: 5128581,
  SYRACUSE_NY: 5140405,
  LONDON_GB: 2643743,
  DUBLIN_IE: 2964574,
  INSIDE_50: 900010,
  OUTSIDE_50: 900011,
  FAIRVIEW_SMALL_OH: 900020,
  FAIRVIEW_BIG_OH: 900021,
} as const;

const COLUMBUS = { lat: 39.96118, lng: -82.99879 };

function place(
  geonamesId: number,
  kind: PlaceKind,
  name: string,
  countryCode: string,
  extra: Partial<PlaceRow> = {},
): PlaceRow {
  const norm = normalizePlaceName(name);
  return {
    geonamesId,
    kind,
    name,
    nameNorm: norm,
    asciiNorm: norm,
    altNames: [],
    regionCode: null,
    regionName: null,
    countryCode,
    lat: null,
    lng: null,
    population: null,
    ...extra,
  };
}

function city(
  geonamesId: number,
  name: string,
  countryCode: string,
  regionCode: string,
  regionName: string,
  lat: number,
  lng: number,
  population: number,
  altNames: string[] = [],
): PlaceRow {
  return place(geonamesId, "city", name, countryCode, {
    regionCode,
    regionName,
    lat,
    lng,
    population,
    altNames,
  });
}

export const PLACE_ROWS: PlaceRow[] = [
  place(P.US, "country", "United States", "US"),
  place(P.GB, "country", "United Kingdom", "GB"),
  place(P.IE, "country", "Ireland", "IE"),
  place(P.TR, "country", "Türkiye", "TR", { asciiNorm: "turkiye" }),
  place(P.TW, "country", "Taiwan", "TW"),
  // GeoNames' legacy Taiwan admin1: the city of Taipei is filed under "Taiwan" (04), not "Taipei" (03).
  place(P.TAIPEI_REGION, "region", "Taipei", "TW", { regionCode: "03", regionName: "Taipei" }),
  place(P.TAIWAN_REGION, "region", "Taiwan", "TW", { regionCode: "04", regionName: "Taiwan" }),
  place(P.OHIO, "region", "Ohio", "US", { regionCode: "OH", regionName: "Ohio" }),
  place(P.TEXAS, "region", "Texas", "US", { regionCode: "TX", regionName: "Texas" }),
  place(P.NEW_YORK_STATE, "region", "New York", "US", { regionCode: "NY", regionName: "New York" }),
  place(P.GEORGIA_STATE, "region", "Georgia", "US", { regionCode: "GA", regionName: "Georgia" }),
  place(P.ENGLAND, "region", "England", "GB", { regionCode: "ENG", regionName: "England" }),
  place(P.LEINSTER, "region", "Leinster", "IE", { regionCode: "L", regionName: "Leinster" }),
  city(P.COLUMBUS_OH, "Columbus", "US", "OH", "Ohio", COLUMBUS.lat, COLUMBUS.lng, 913175, ["cmh"]),
  city(P.WESTERVILLE_OH, "Westerville", "US", "OH", "Ohio", 40.12617, -82.92907, 38384),
  city(P.DUBLIN_OH, "Dublin", "US", "OH", "Ohio", 40.09923, -83.11408, 45098),
  city(P.LONDON_OH, "London", "US", "OH", "Ohio", 39.88645, -83.44825, 10060),
  city(P.CINCINNATI_OH, "Cincinnati", "US", "OH", "Ohio", 39.12711, -84.51439, 309317),
  city(P.COLUMBUS_GA, "Columbus", "US", "GA", "Georgia", 32.46098, -84.98771, 206922),
  city(P.DALLAS_TX, "Dallas", "US", "TX", "Texas", 32.78306, -96.80667, 1300092),
  city(P.HOUSTON_TX, "Houston", "US", "TX", "Texas", 29.76328, -95.36327, 2296224),
  city(P.NEW_YORK_CITY, "New York City", "US", "NY", "New York", 40.71427, -74.00597, 8804190, [
    "new york",
    "nyc",
  ]),
  city(P.SYRACUSE_NY, "Syracuse", "US", "NY", "New York", 43.04812, -76.14742, 144142),
  city(P.LONDON_GB, "London", "GB", "ENG", "England", 51.50853, -0.12574, 8961989),
  city(P.DUBLIN_IE, "Dublin", "IE", "L", "Leinster", 53.33306, -6.24889, 1024027, [
    "baile atha cliath",
  ]),
  city(P.TAIPEI, "Taipei", "TW", "04", "Taiwan", 25.04776, 121.53185, 7871900),
  city(P.INSIDE_50, "Insideville", "US", "OH", "Ohio", COLUMBUS.lat + 0.71643, COLUMBUS.lng, 600),
  city(P.OUTSIDE_50, "Outsideville", "US", "OH", "Ohio", COLUMBUS.lat + 0.7309, COLUMBUS.lng, 600),
  city(P.FAIRVIEW_SMALL_OH, "Fairview", "US", "OH", "Ohio", 41.04, -81.6, 700),
  city(P.FAIRVIEW_BIG_OH, "Fairview", "US", "OH", "Ohio", 41.45, -81.85, 9000),
];

/** Load the fixture gazetteer through the real upsert. */
export async function seedPlaces(db: Db): Promise<void> {
  await upsertPlaces(db, PLACE_ROWS);
}
