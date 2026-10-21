/**
 * Fetch (or read from a directory) the GeoNames dump files and parse them into `places` rows: countries,
 * regions, the cities of 500+ people, then every other US populated place (the US dump; the normalizer
 * always names a US place's state, so small towns there add no ambiguity). Shared by places:load and
 * eval:locations, so the eval's local gazetteer is built from exactly the rows production loads.
 * Node-only (fetch + fs + zlib).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  parseAdmin1,
  parseCities,
  parseCountries,
  parsePopulatedPlaces,
  type ParseResult,
  type PlaceRow,
} from "./geonames";
import { readZipEntry } from "./zip";

const BASE_URL = "https://download.geonames.org/export/dump";
export const GEONAMES_FILES = {
  cities: "cities500.zip",
  admin1: "admin1CodesASCII.txt",
  countries: "countryInfo.txt",
  us: "US.zip",
} as const;
/** A parse that skips more than this share of a file's lines means the format changed: load nothing. */
const MAX_SKIPPED_SHARE = 0.01;

export interface GeonamesLoad {
  rows: PlaceRow[];
  /** Per file: rows parsed and malformed lines skipped. */
  summary: {
    label: "countries" | "regions" | "cities" | "US places";
    parsed: number;
    skipped: number;
  }[];
}

/** Download the files (or read them from `from`), parse and check them. Throws if a file looks wrong. */
export async function loadGeonames(opts: { from?: string } = {}): Promise<GeonamesLoad> {
  const read = (file: string) => (opts.from ? readFile(join(opts.from, file)) : download(file));
  const [citiesZip, admin1Text, countriesText, usZip] = await Promise.all([
    read(GEONAMES_FILES.cities),
    read(GEONAMES_FILES.admin1),
    read(GEONAMES_FILES.countries),
    read(GEONAMES_FILES.us),
  ]);
  const countries = parseCountries(countriesText.toString("utf8"));
  const regions = parseAdmin1(admin1Text.toString("utf8"));
  const cities = parseCities(
    readZipEntry(citiesZip, "cities500.txt").toString("utf8"),
    regions.names,
  );
  // The US dump repeats cities500's US cities; those keep their cities500 row.
  const inCities = new Set(cities.rows.map((r) => r.geonamesId));
  const usParsed = parsePopulatedPlaces(readZipEntry(usZip, "US.txt"), regions.names);
  const us = { ...usParsed, rows: usParsed.rows.filter((r) => !inCities.has(r.geonamesId)) };
  const parts: [GeonamesLoad["summary"][number]["label"], ParseResult][] = [
    ["countries", countries],
    ["regions", regions],
    ["cities", cities],
    ["US places", us],
  ];
  for (const [label, parsed] of parts) {
    if (parsed.rows.length === 0 || parsed.skipped > parsed.rows.length * MAX_SKIPPED_SHARE) {
      throw new Error(
        `GeoNames ${label}: ${parsed.skipped} malformed line(s) for ${parsed.rows.length} parsed; the format may have changed.`,
      );
    }
  }
  return {
    rows: [...countries.rows, ...regions.rows, ...cities.rows, ...us.rows],
    summary: parts.map(([label, p]) => ({ label, parsed: p.rows.length, skipped: p.skipped })),
  };
}

async function download(file: string): Promise<Buffer> {
  const res = await fetch(`${BASE_URL}/${file}`);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`GET ${file} returned HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
