/**
 * The `places` gazetteer: the bulk upsert places:load writes through, and the reads the location
 * normalizer's check and user:set-prefs make. Lookups match the `*_norm` keys, so callers pass names
 * through normalizePlaceName (@opusfinder/shared) first.
 */
import { inArray, sql } from "drizzle-orm";

import { normalizePlaceName, type PlaceKind, type PlaceSource } from "@opusfinder/shared";

import type { Db } from "../client";
import type { PlaceRow } from "../geonames";
import { places } from "../schema";
import { resultRows, textArrayLiteral } from "./sql";

export type Place = typeof places.$inferSelect;

/** A city found by {@link findCities}: `key` is the "CC|name" it answered, `byAlt` whether it matched an
 *  alternate name rather than its name or ASCII name, `source` the GeoNames list it came from. */
export interface CityMatch {
  key: string;
  byAlt: boolean;
  source: PlaceSource;
  geonamesId: number;
  name: string;
  regionCode: string | null;
  countryCode: string;
  population: number;
}

const UPSERT_CHUNK = 1000;

/** Insert or update places by geonames_id; never deletes. A row GeoNames hasn't changed is left alone, so a
 *  re-run rewrites only what changed. Returns the number of rows sent. */
export async function upsertPlaces(db: Db, rows: PlaceRow[]): Promise<number> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    await db
      .insert(places)
      .values(rows.slice(i, i + UPSERT_CHUNK))
      .onConflictDoUpdate({
        target: places.geonamesId,
        set: {
          kind: sql`excluded.kind`,
          name: sql`excluded.name`,
          nameNorm: sql`excluded.name_norm`,
          asciiNorm: sql`excluded.ascii_norm`,
          altNames: sql`excluded.alt_names`,
          regionCode: sql`excluded.region_code`,
          regionName: sql`excluded.region_name`,
          countryCode: sql`excluded.country_code`,
          lat: sql`excluded.lat`,
          lng: sql`excluded.lng`,
          population: sql`excluded.population`,
          source: sql`excluded.source`,
        },
        setWhere: sql`(${places.kind}, ${places.name}, ${places.nameNorm}, ${places.asciiNorm},
          ${places.altNames}, ${places.regionCode}, ${places.regionName}, ${places.countryCode},
          ${places.lat}, ${places.lng}, ${places.population}, ${places.source})
          IS DISTINCT FROM (excluded.kind, excluded.name, excluded.name_norm, excluded.ascii_norm,
          excluded.alt_names, excluded.region_code, excluded.region_name, excluded.country_code,
          excluded.lat, excluded.lng, excluded.population, excluded.source)`,
      });
  }
  return rows.length;
}

/** Every country and first-level region (~4k rows): small enough for the check to hold in memory. */
export function listCountriesAndRegions(db: Db): Promise<Place[]> {
  return db
    .select()
    .from(places)
    .where(inArray(places.kind, ["country", "region"] satisfies PlaceKind[]));
}

/** Places by id, any kind. */
export function getPlaces(db: Db, ids: number[]): Promise<Place[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return db.select().from(places).where(inArray(places.geonamesId, ids));
}

/**
 * Cities matching (country, normalized name) keys: by name or ASCII name, and by alternate name, each in
 * one round trip however many keys there are (two bound arrays). The caller prefers a name match and falls
 * back to an alternate one, so a small town that happens to carry a big city's nickname never wins.
 */
export async function findCities(
  db: Db,
  keys: { countryCode: string; nameNorm: string }[],
): Promise<CityMatch[]> {
  const unique = [...new Map(keys.map((k) => [cityKey(k.countryCode, k.nameNorm), k])).values()];
  if (unique.length === 0) return [];
  const [byName, byAlt] = await Promise.all([
    matchCities(db, unique, "name"),
    matchCities(db, unique, "alt"),
  ]);
  return [...byName, ...byAlt];
}

/** The "CC|name" key {@link findCities} answers under. */
export function cityKey(countryCode: string, nameNorm: string): string {
  return `${countryCode}|${nameNorm}`;
}

async function matchCities(
  db: Db,
  keys: { countryCode: string; nameNorm: string }[],
  by: "name" | "alt",
): Promise<CityMatch[]> {
  const countries = textArrayLiteral(keys.map((k) => k.countryCode));
  const names = textArrayLiteral(keys.map((k) => k.nameNorm));
  const match =
    by === "name"
      ? sql`(p.name_norm = k.name OR p.ascii_norm = k.name)`
      : sql`p.alt_names @> ARRAY[k.name]`;
  const result = await db.execute(sql`
    SELECT k.country || '|' || k.name AS key, p.geonames_id, p.name, p.region_code, p.country_code,
           COALESCE(p.population, 0) AS population, p.source
    FROM unnest(${countries}::text[], ${names}::text[]) AS k(country, name)
    JOIN ${places} p ON p.kind = 'city' AND p.country_code = k.country AND ${match}
  `);
  return resultRows(result).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      key: String(r.key),
      byAlt: by === "alt",
      source: String(r.source) as PlaceSource,
      geonamesId: Number(r.geonames_id),
      name: String(r.name),
      regionCode: r.region_code === null ? null : String(r.region_code),
      countryCode: String(r.country_code),
      population: Number(r.population),
    };
  });
}

/**
 * Cities a typed home could mean, from its normalized parts (normalizePlaceName): a main-list city matched
 * by name or ASCII name, else by alternate name, else a US-dump place by name or ASCII name (the dump only
 * fills gaps, so "Columbus, Ohio" never turns ambiguous over a hamlet of the same name), narrowed by a
 * region given as its code or name and a country given as its ISO code or name. Largest first, at most
 * `limit`.
 */
export async function findHomeCandidates(
  db: Db,
  query: { city: string; region?: string; country?: string },
  limit = 10,
): Promise<HomeCandidate[]> {
  const { city, region, country } = query;
  const regionFilter = region
    ? sql`AND EXISTS (SELECT 1 FROM ${places} r WHERE r.kind = 'region' AND r.country_code = p.country_code
        AND r.region_code = p.region_code
        AND (upper(r.region_code) = upper(${region}) OR r.name_norm = ${region} OR r.ascii_norm = ${region}))`
    : sql``;
  const countryFilter = country
    ? sql`AND (p.country_code = upper(${country}) OR EXISTS (SELECT 1 FROM ${places} c
        WHERE c.kind = 'country' AND c.country_code = p.country_code AND c.name_norm = ${country}))`
    : sql``;
  const byName = sql`(p.name_norm = ${city} OR p.ascii_norm = ${city})`;
  for (const match of [
    sql`p.source = 'main' AND ${byName}`,
    sql`p.source = 'main' AND p.alt_names @> ARRAY[${city}]::text[]`,
    sql`p.source = 'us-dump' AND ${byName}`,
  ]) {
    const result = await db.execute(sql`
      SELECT p.geonames_id, p.name, p.region_code, p.region_name, p.country_code, p.lat, p.lng, p.population
      FROM ${places} p
      WHERE p.kind = 'city' AND ${match} ${regionFilter} ${countryFilter}
      ORDER BY p.population DESC NULLS LAST, p.geonames_id
      LIMIT ${limit}
    `);
    const rows = resultRows(result).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        geonamesId: Number(r.geonames_id),
        name: String(r.name),
        regionCode: r.region_code === null ? null : String(r.region_code),
        regionName: r.region_name === null ? null : String(r.region_name),
        countryCode: String(r.country_code),
        lat: Number(r.lat),
        lng: Number(r.lng),
        population: Number(r.population ?? 0),
      };
    });
    if (rows.length > 0) return rows;
  }
  return [];
}

/** A city {@link findHomeCandidates} returns. */
export interface HomeCandidate {
  geonamesId: number;
  name: string;
  regionCode: string | null;
  regionName: string | null;
  countryCode: string;
  lat: number;
  lng: number;
  population: number;
}

/** What {@link findHomePlace} found: exactly one city, or the candidates (none, or several). */
export type HomePlaceLookup = { place: HomeCandidate } | { candidates: HomeCandidate[] };

/**
 * Resolve a typed home to one city: "City", "City, Region-or-Country" or "City, Region, Country", or a
 * GeoNames id. A two-part home tries the second part as a region first ("Atlanta, Georgia"), then as a
 * country ("Tbilisi, Georgia"). Deterministic; no LLM.
 */
export async function findHomePlace(db: Db, text: string): Promise<HomePlaceLookup> {
  const trimmed = text.trim();
  if (/^\d{1,10}$/.test(trimmed)) {
    const [place] = await getPlaces(db, [Number(trimmed)]);
    if (!place || place.kind !== "city" || place.lat === null || place.lng === null)
      return { candidates: [] };
    return {
      place: {
        geonamesId: place.geonamesId,
        name: place.name,
        regionCode: place.regionCode,
        regionName: place.regionName,
        countryCode: place.countryCode,
        lat: place.lat,
        lng: place.lng,
        population: place.population ?? 0,
      },
    };
  }
  const [city, second, third, ...rest] = trimmed.split(",").map((p) => normalizePlaceName(p));
  if (!city || rest.length > 0) return { candidates: [] };
  const attempts =
    third !== undefined
      ? [{ city, region: second || undefined, country: third || undefined }]
      : second
        ? [
            { city, region: second },
            { city, country: second },
          ]
        : [{ city }];
  for (const query of attempts) {
    const candidates = await findHomeCandidates(db, query);
    if (candidates.length === 1) return { place: candidates[0]! };
    if (candidates.length > 1) return { candidates };
  }
  return { candidates: [] };
}
