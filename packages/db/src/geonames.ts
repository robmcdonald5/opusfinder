/**
 * Parsers for the three GeoNames dump files `places:load` reads (download.geonames.org/export/dump,
 * CC BY 4.0): cities500.txt, admin1CodesASCII.txt and countryInfo.txt. The files are untrusted external
 * data, so every field is checked for type and range; a line that fails any check is skipped and
 * counted, never half-loaded. Pure: no I/O, so the tests drive it with small fixture strings.
 */
import { normalizePlaceName, type PlaceKind } from "@opusfinder/shared";

/** One `places` row, ready to upsert. */
export interface PlaceRow {
  geonamesId: number;
  kind: PlaceKind;
  name: string;
  nameNorm: string;
  asciiNorm: string;
  altNames: string[];
  regionCode: string | null;
  regionName: string | null;
  countryCode: string;
  lat: number | null;
  lng: number | null;
  population: number | null;
}

export interface ParseResult {
  rows: PlaceRow[];
  /** Lines that failed a field check (not comments or blank lines). */
  skipped: number;
}

/** Feature codes in cities500 that are not a living place: historical, abandoned, destroyed, a former
 *  capital. Everything else (PPL, PPLA*, PPLC, PPLX sections, …) loads. */
const DEAD_FEATURE_CODES = new Set(["PPLH", "PPLQ", "PPLW", "PPLCH"]);

/** Longest name kept; GeoNames' longest real names are well under this. */
const MAX_NAME_LENGTH = 200;
/** Alternate names kept per city. NYC has a few hundred in every script; the Latin ones that matter
 *  ("New York", "NYC") are among the first. */
const MAX_ALT_NAMES = 40;

const COUNTRY_CODE = /^[A-Z]{2}$/;
const ADMIN1_CODE = /^[A-Za-z0-9]{1,20}$/;
const DIGITS = /^\d{1,10}$/;
/** A decimal number as GeoNames writes coordinates. */
const DECIMAL = /^-?\d{1,3}(\.\d+)?$/;
/** Control characters (C0, DEL, C1): never part of a real place name. */
const CONTROL = /\p{Cc}/u;
/** A normalized alternate name that is Latin-script only. */
const LATIN_NORM = /^[a-z0-9 ]+$/;

/** Parse cities500.txt (19 tab-separated fields per line). `regionNames` maps "CC.code" to the region's
 *  name, from {@link parseAdmin1}. */
export function parseCities(text: string, regionNames: ReadonlyMap<string, string>): ParseResult {
  const rows: PlaceRow[] = [];
  let skipped = 0;
  for (const line of lines(text)) {
    const f = line.split("\t");
    const row = f.length === 19 ? cityRow(f, regionNames) : null;
    if (row === "dead") continue;
    if (row) rows.push(row);
    else skipped++;
  }
  return { rows, skipped };
}

function cityRow(f: string[], regionNames: ReadonlyMap<string, string>): PlaceRow | "dead" | null {
  const [
    id,
    name,
    ascii,
    alternates,
    lat,
    lng,
    ,
    featureCode,
    country,
    ,
    admin1,
    ,
    ,
    ,
    population,
  ] = f;
  if (DEAD_FEATURE_CODES.has(featureCode ?? "")) return "dead";
  const geonamesId = parseId(id);
  const cleanName = parseName(name);
  const cleanAscii = parseName(ascii) ?? cleanName;
  const countryCode = parseCountryCode(country);
  const latitude = parseCoordinate(lat, 90);
  const longitude = parseCoordinate(lng, 180);
  const pop = population === "" ? 0 : parseCount(population);
  if (
    geonamesId === null ||
    cleanName === null ||
    cleanAscii === null ||
    countryCode === null ||
    latitude === null ||
    longitude === null ||
    pop === null
  ) {
    return null;
  }
  // "00" and "" both mean GeoNames assigned no first-level region.
  const regionCode = admin1 && admin1 !== "00" && ADMIN1_CODE.test(admin1) ? admin1 : null;
  if (admin1 && admin1 !== "00" && regionCode === null) return null;
  const nameNorm = normalizePlaceName(cleanName);
  const asciiNorm = normalizePlaceName(cleanAscii);
  if (!nameNorm || !asciiNorm) return null;
  return {
    geonamesId,
    kind: "city",
    name: cleanName,
    nameNorm,
    asciiNorm,
    altNames: altNames(alternates ?? "", [nameNorm, asciiNorm]),
    regionCode,
    regionName: regionCode ? (regionNames.get(`${countryCode}.${regionCode}`) ?? null) : null,
    countryCode,
    lat: latitude,
    lng: longitude,
    population: pop,
  };
}

/** The normalized Latin-script alternate names, minus the ones the name already gives, deduped. */
function altNames(field: string, exclude: string[]): string[] {
  const out = new Set<string>();
  for (const alt of field.split(",")) {
    if (out.size >= MAX_ALT_NAMES) break;
    if (alt.length === 0 || alt.length > MAX_NAME_LENGTH || CONTROL.test(alt)) continue;
    const norm = normalizePlaceName(alt);
    if (norm && LATIN_NORM.test(norm) && !exclude.includes(norm)) out.add(norm);
  }
  return [...out];
}

/** Parse admin1CodesASCII.txt: `CC.code \t name \t asciiname \t geonameid`. Returns the region rows and
 *  the "CC.code" → name map the city parser uses. */
export function parseAdmin1(text: string): ParseResult & { names: Map<string, string> } {
  const rows: PlaceRow[] = [];
  const names = new Map<string, string>();
  let skipped = 0;
  for (const line of lines(text)) {
    const [key, name, ascii, id, ...rest] = line.split("\t");
    const dot = key?.indexOf(".") ?? -1;
    const countryCode = key && dot > 0 ? parseCountryCode(key.slice(0, dot)) : null;
    const regionCode = key && dot > 0 ? key.slice(dot + 1) : "";
    const geonamesId = parseId(id);
    const cleanName = parseName(name);
    const cleanAscii = parseName(ascii) ?? cleanName;
    if (
      rest.length > 0 ||
      countryCode === null ||
      !ADMIN1_CODE.test(regionCode) ||
      geonamesId === null ||
      cleanName === null ||
      cleanAscii === null
    ) {
      skipped++;
      continue;
    }
    const nameNorm = normalizePlaceName(cleanName);
    const asciiNorm = normalizePlaceName(cleanAscii);
    if (!nameNorm || !asciiNorm) {
      skipped++;
      continue;
    }
    names.set(`${countryCode}.${regionCode}`, cleanName);
    rows.push({
      geonamesId,
      kind: "region",
      name: cleanName,
      nameNorm,
      asciiNorm,
      altNames: [],
      regionCode,
      regionName: cleanName,
      countryCode,
      lat: null,
      lng: null,
      population: null,
    });
  }
  return { rows, skipped, names };
}

/** Parse countryInfo.txt: `#`-prefixed header/comment lines, then 19 tab-separated fields (ISO code in
 *  the first, name in the fifth, population in the eighth, geonameid in the seventeenth). A country
 *  GeoNames lists without a geonameid (a dissolved code) is skipped as invalid. */
export function parseCountries(text: string): ParseResult {
  const rows: PlaceRow[] = [];
  let skipped = 0;
  for (const line of lines(text)) {
    if (line.startsWith("#")) continue;
    const f = line.split("\t");
    const countryCode = parseCountryCode(f[0]);
    const cleanName = parseName(f[4]);
    const population = f[7] === "" ? null : parseCount(f[7]);
    const geonamesId = parseId(f[16]);
    const nameNorm = cleanName ? normalizePlaceName(cleanName) : "";
    if (
      f.length !== 19 ||
      countryCode === null ||
      cleanName === null ||
      (f[7] !== "" && population === null) ||
      geonamesId === null ||
      !nameNorm
    ) {
      skipped++;
      continue;
    }
    rows.push({
      geonamesId,
      kind: "country",
      name: cleanName,
      nameNorm,
      asciiNorm: nameNorm,
      altNames: [],
      regionCode: null,
      regionName: null,
      countryCode,
      lat: null,
      lng: null,
      population,
    });
  }
  return { rows, skipped };
}

/** Non-blank lines, CRLF-tolerant. */
function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

function parseId(value: string | undefined): number | null {
  if (!value || !DIGITS.test(value)) return null;
  const n = Number(value);
  return n > 0 && n <= 2_147_483_647 ? n : null;
}

/** A population. Fits the integer column (the largest country is ~1.4 billion). */
function parseCount(value: string | undefined): number | null {
  if (value === undefined || !DIGITS.test(value)) return null;
  const n = Number(value);
  return n <= 2_147_483_647 ? n : null;
}

function parseCoordinate(value: string | undefined, limit: number): number | null {
  if (!value || !DECIMAL.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

function parseCountryCode(value: string | undefined): string | null {
  return value && COUNTRY_CODE.test(value) ? value : null;
}

function parseName(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH || CONTROL.test(trimmed)) return null;
  return trimmed;
}
