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
  DE: 2921044,
  FR: 3017382,
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
  // Real rows for the check's spelling tolerance (names.ts).
  KZ: 1522867,
  NG: 2328926,
  AT: 2782113,
  CH: 2658434,
  PE: 3932488,
  MY: 1733045,
  ALMATY_REGION: 1537162,
  ALMATY_CITY_REGION: 1526395,
  OGUN_STATE: 2327546,
  SALZBURG: 2766823,
  SAINT_GALLEN: 2658821,
  LIMA_REGION: 3936452,
  LIMA_PROVINCE: 3936451,
  MICHIGAN: 5001836,
  MISSISSIPPI: 4436296,
  ILLINOIS: 4896861,
  SELANGOR: 1733037,
  KUALA_LUMPUR_REGION: 1733046,
  ALMATY: 1526384,
  WALS: 2761941,
  RAPPERSWIL: 2659099,
  LIMA: 3936456,
  SAINT_JOSEPH_MI: 5008327,
  KUALA_LUMPUR: 1735161,
  // From the US dump: a community of no recorded population, and the larger namesake in another state.
  MCHENRY_MS: 4435457,
  MCHENRY_IL: 4901663,
  // The review's cases: a main-list city and the US-dump namesake (or alternate spelling) that must not
  // displace it, two dump-only namesakes in one state, and a compound whose parts are other towns.
  VIRGINIA: 6254928,
  MASSACHUSETTS: 6254926,
  KENTUCKY: 6254925,
  CALIFORNIA: 5332921,
  POWHATAN_VA: 4780220,
  POWHATAN_VA_DUMP: 4780219,
  MARLBOROUGH_MA: 4943170,
  MARLBORO_MA_DUMP: 4943167,
  RADCLIFF_KY: 4305504,
  RADCLIFFE_KY_DUMP: 4305506,
  SIMI_VALLEY_CA: 5396003,
  SIMI_CA_DUMP: 5395991,
  BIG_SPRING_TX: 5517061,
  BIG_SPRINGS_TX_DUMP: 4674388,
  BROOKLYN_GA_SECTION: 4184544,
  BROOKLYN_GA_DUMP: 4828280,
  SALEM_VA: 4784112,
  WINSTON_VA_DUMP: 4794247,
  STOCKTON_ENG: 2636878,
  // A dump place reachable only by an alternate name.
  ALT_ONLY_DUMP: 900030,
  // City-regions next to the region around them.
  UA: 690791,
  MZ: 1036973,
  KG: 1527747,
  KYIV_CITY_REGION: 703447,
  KYIV_OBLAST: 703446,
  MAPUTO_CITY_REGION: 1105845,
  MAPUTO_PROVINCE: 1040649,
  OSH_CITY_REGION: 10300944,
  OSH_REGION: 1346798,
  KYIV: 703448,
  MAPUTO: 1040652,
  OSH: 1527534,
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
    source: "main",
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

/** A place from GeoNames' US dump (no population recorded, unless given). */
function usDump(
  geonamesId: number,
  name: string,
  regionCode: string,
  regionName: string,
  lat: number,
  lng: number,
  extra: Partial<PlaceRow> = {},
): PlaceRow {
  return {
    ...city(geonamesId, name, "US", regionCode, regionName, lat, lng, 0),
    source: "us-dump",
    ...extra,
  };
}

function region(geonamesId: number, name: string, countryCode: string, regionCode: string) {
  return place(geonamesId, "region", name, countryCode, { regionCode, regionName: name });
}

export const PLACE_ROWS: PlaceRow[] = [
  place(P.US, "country", "United States", "US"),
  place(P.GB, "country", "United Kingdom", "GB"),
  place(P.IE, "country", "Ireland", "IE"),
  place(P.TR, "country", "Türkiye", "TR", { asciiNorm: "turkiye" }),
  place(P.TW, "country", "Taiwan", "TW"),
  place(P.DE, "country", "Germany", "DE"),
  place(P.FR, "country", "France", "FR"),
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
  place(P.KZ, "country", "Kazakhstan", "KZ"),
  place(P.NG, "country", "Nigeria", "NG"),
  place(P.AT, "country", "Austria", "AT"),
  place(P.CH, "country", "Switzerland", "CH"),
  place(P.PE, "country", "Peru", "PE"),
  place(P.MY, "country", "Malaysia", "MY"),
  region(P.ALMATY_REGION, "Almaty Region", "KZ", "01"),
  region(P.ALMATY_CITY_REGION, "Almaty", "KZ", "02"),
  region(P.OGUN_STATE, "Ogun State", "NG", "16"),
  region(P.SALZBURG, "Salzburg", "AT", "05"),
  region(P.SAINT_GALLEN, "Saint Gallen", "CH", "SG"),
  region(P.LIMA_REGION, "Lima region", "PE", "15"),
  region(P.LIMA_PROVINCE, "Lima Province", "PE", "LMA"),
  region(P.MICHIGAN, "Michigan", "US", "MI"),
  region(P.MISSISSIPPI, "Mississippi", "US", "MS"),
  region(P.ILLINOIS, "Illinois", "US", "IL"),
  region(P.SELANGOR, "Selangor", "MY", "12"),
  region(P.KUALA_LUMPUR_REGION, "Kuala Lumpur", "MY", "14"),
  city(P.ALMATY, "Almaty", "KZ", "02", "Almaty", 43.25249, 76.9115, 1977011, ["alma ata"]),
  city(P.WALS, "Wals", "AT", "05", "Salzburg", 47.78333, 12.96667, 3626),
  city(P.RAPPERSWIL, "Rapperswil", "CH", "SG", "Saint Gallen", 47.22557, 8.82228, 34776),
  city(P.LIMA, "Lima", "PE", "LMA", "Lima Province", -12.04318, -77.02824, 7737002),
  city(P.SAINT_JOSEPH_MI, "Saint Joseph", "US", "MI", "Michigan", 42.10976, -86.48002, 8365),
  city(P.KUALA_LUMPUR, "Kuala Lumpur", "MY", "14", "Kuala Lumpur", 3.1412, 101.68653, 1453975),
  usDump(P.MCHENRY_MS, "McHenry", "MS", "Mississippi", 30.70769, -89.13838),
  city(P.MCHENRY_IL, "McHenry", "US", "IL", "Illinois", 42.33335, -88.26675, 26657),
  region(P.VIRGINIA, "Virginia", "US", "VA"),
  region(P.MASSACHUSETTS, "Massachusetts", "US", "MA"),
  region(P.KENTUCKY, "Kentucky", "US", "KY"),
  region(P.CALIFORNIA, "California", "US", "CA"),
  city(P.POWHATAN_VA, "Powhatan", "US", "VA", "Virginia", 37.54209, -77.91889, 0, [
    "powhatan court house",
  ]),
  usDump(P.POWHATAN_VA_DUMP, "Powhatan", "VA", "Virginia", 37.33987, -79.2478),
  city(P.MARLBOROUGH_MA, "Marlborough", "US", "MA", "Massachusetts", 42.34593, -71.55229, 39818, [
    "marlboro",
  ]),
  usDump(P.MARLBORO_MA_DUMP, "Marlboro", "MA", "Massachusetts", 42.71676, -70.97311),
  city(P.RADCLIFF_KY, "Radcliff", "US", "KY", "Kentucky", 37.84035, -85.94913, 22387, [
    "radcliffe",
  ]),
  usDump(P.RADCLIFFE_KY_DUMP, "Radcliffe", "KY", "Kentucky", 38.07841, -84.46688),
  city(P.SIMI_VALLEY_CA, "Simi Valley", "US", "CA", "California", 34.26945, -118.78148, 126788, [
    "simi",
  ]),
  usDump(P.SIMI_CA_DUMP, "Simi", "CA", "California", 38.63991, -122.87444),
  city(P.BIG_SPRING_TX, "Big Spring", "US", "TX", "Texas", 32.2504, -101.47874, 28862, [
    "big springs",
  ]),
  usDump(P.BIG_SPRINGS_TX_DUMP, "Big Springs", "TX", "Texas", 32.06739, -94.96744),
  usDump(P.BROOKLYN_GA_SECTION, "Brooklyn", "GA", "Georgia", 33.76038, -84.39493),
  usDump(P.BROOKLYN_GA_DUMP, "Brooklyn", "GA", "Georgia", 32.17377, -84.70853),
  city(P.SALEM_VA, "Salem", "US", "VA", "Virginia", 37.29347, -80.05476, 25432),
  usDump(P.WINSTON_VA_DUMP, "Winston", "VA", "Virginia", 38.41013, -78.00944),
  city(P.STOCKTON_ENG, "Stockton", "GB", "ENG", "England", 52.27181, -1.36055, 1347),
  usDump(P.ALT_ONLY_DUMP, "Gumbo Flats", "MS", "Mississippi", 31, -89.5, { altNames: ["gumbo"] }),
  place(P.UA, "country", "Ukraine", "UA"),
  place(P.MZ, "country", "Mozambique", "MZ"),
  place(P.KG, "country", "Kyrgyzstan", "KG"),
  region(P.KYIV_CITY_REGION, "Kyiv City", "UA", "12"),
  region(P.KYIV_OBLAST, "Kyiv Oblast", "UA", "13"),
  region(P.MAPUTO_CITY_REGION, "Maputo City", "MZ", "11"),
  region(P.MAPUTO_PROVINCE, "Maputo Province", "MZ", "04"),
  region(P.OSH_CITY_REGION, "Osh City", "KG", "10"),
  region(P.OSH_REGION, "Osh Region", "KG", "08"),
  city(P.KYIV, "Kyiv", "UA", "12", "Kyiv City", 50.45466, 30.5238, 2952301),
  city(P.MAPUTO, "Maputo", "MZ", "11", "Maputo City", -25.96553, 32.58322, 1254837),
  city(P.OSH, "Osh", "KG", "08", "Osh Region", 40.52828, 72.7985, 322164),
];

/** Load the fixture gazetteer through the real upsert. */
export async function seedPlaces(db: Db): Promise<void> {
  await upsertPlaces(db, PLACE_ROWS);
}
