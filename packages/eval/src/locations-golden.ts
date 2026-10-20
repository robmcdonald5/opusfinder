/**
 * The location normalizer's golden set (data/locations-golden.jsonl): real (company, location string)
 * pairs from production with the company's other strings as context, and, once labeled and reviewed,
 * the expected answer as GeoNames place ids, remote countries and areas (by the list's names, from
 * @opusfinder/locations). eval:locations scores the normalizer's checked answer against it by exact match.
 */
import { readFileSync } from "node:fs";

import { AREAS, readArea, type AreaName } from "@opusfinder/locations";
import { isRecord, type UnmatchedPlace } from "@opusfinder/shared";

/** A labeled place: its GeoNames id, with the names shown on the review sheet (the id is what's scored). */
export interface GoldenPlace {
  geonamesId: number;
  name: string;
  region: string | null;
  country: string;
  kind: string;
}

export interface GoldenExpected {
  places: GoldenPlace[];
  /** Other place sets that count as right too, where the answer is a judgment between equally fair places
   *  (the nearest town to a site GeoNames doesn't list). Written by hand. */
  alternatives?: GoldenPlace[][];
  remoteCountries: string[];
  /** Areas the job is limited to; scored as the countries they cover, with the remote countries. */
  areas: AreaName[];
  note?: string;
}

export interface GoldenEntry {
  id: string;
  /** The sampling bucket it was drawn from: bare, multi, label, coded, remote, area, plain. */
  category: string;
  company: { slug: string; source: string };
  raw: string;
  /** Active jobs listing this pair when it was pulled. */
  jobs: number;
  /** The company's other location strings, as the production request shows them. */
  otherStrings: string[];
  /** Absent until the pair is labeled and reviewed. */
  expected?: GoldenExpected;
}

export function loadGolden(path: string): GoldenEntry[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const entries: GoldenEntry[] = [];
  const ids = new Set<string>();
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    const at = `${path}:${i + 1}`;
    const entry = validateEntry(JSON.parse(line) as unknown, at);
    if (ids.has(entry.id)) throw new Error(`${at}: duplicate id ${entry.id}.`);
    ids.add(entry.id);
    entries.push(entry);
  });
  return entries;
}

function validateEntry(value: unknown, at: string): GoldenEntry {
  if (!isRecord(value)) throw new Error(`${at}: not an object.`);
  const { id, category, company, raw, jobs, otherStrings, expected } = value;
  if (typeof id !== "string" || typeof category !== "string" || typeof raw !== "string") {
    throw new Error(`${at}: id, category and raw must be strings.`);
  }
  if (
    !isRecord(company) ||
    typeof company.slug !== "string" ||
    typeof company.source !== "string"
  ) {
    throw new Error(`${at}: company must be { slug, source }.`);
  }
  if (typeof jobs !== "number" || !isStringArray(otherStrings)) {
    throw new Error(`${at}: jobs must be a number and otherStrings a string[].`);
  }
  const entry: GoldenEntry = {
    id,
    category,
    company: { slug: company.slug, source: company.source },
    raw,
    jobs,
    otherStrings,
  };
  if (expected !== undefined) entry.expected = validateExpected(expected, at);
  return entry;
}

function validateExpected(value: unknown, at: string): GoldenExpected {
  if (!isRecord(value) || !Array.isArray(value.places) || !isStringArray(value.remoteCountries)) {
    throw new Error(`${at}: expected must be { places[], remoteCountries[] }.`);
  }
  const places = validatePlaces(value.places, `${at}: expected.places`);
  if (value.alternatives !== undefined && !Array.isArray(value.alternatives)) {
    throw new Error(`${at}: expected.alternatives must be an array of place lists.`);
  }
  const alternatives = value.alternatives?.map((alt, j) =>
    validatePlaces(alt, `${at}: expected.alternatives[${j}]`),
  );
  const areas = value.areas === undefined ? [] : value.areas;
  if (!isStringArray(areas)) throw new Error(`${at}: expected.areas must be a string[].`);
  return {
    places,
    ...(alternatives ? { alternatives } : {}),
    remoteCountries: value.remoteCountries,
    areas: areas.map((a) => {
      const area = readArea(a);
      if (area === null || area === "no-limit" || area !== a) {
        throw new Error(
          `${at}: expected.areas has "${a}", which is not an area's name on the list.`,
        );
      }
      return area;
    }),
    ...(typeof value.note === "string" ? { note: value.note } : {}),
  };
}

function validatePlaces(value: unknown, at: string): GoldenPlace[] {
  if (!Array.isArray(value)) throw new Error(`${at} must be an array.`);
  return value.map((p, j) => {
    if (
      !isRecord(p) ||
      typeof p.geonamesId !== "number" ||
      typeof p.name !== "string" ||
      typeof p.country !== "string"
    ) {
      throw new Error(`${at}[${j}] needs geonamesId, name, country.`);
    }
    return {
      geonamesId: p.geonamesId,
      name: p.name,
      region: typeof p.region === "string" ? p.region : null,
      country: p.country,
      kind: typeof p.kind === "string" ? p.kind : "city",
    };
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Exact match: the same set of place ids as the expected places or one of their alternatives, the same
 *  set of remote countries (the expected areas' countries included), and no area off the list. */
export function answerMatches(
  expected: GoldenExpected,
  got: { placeIds: number[]; remoteCountries: string[]; unmatched?: UnmatchedPlace[] },
): boolean {
  return (
    [expected.places, ...(expected.alternatives ?? [])].some((places) =>
      sameSet(
        places.map((p) => p.geonamesId),
        got.placeIds,
      ),
    ) &&
    sameSet(
      [...expected.remoteCountries, ...expected.areas.flatMap((a) => AREAS[a])],
      got.remoteCountries,
    ) &&
    !(got.unmatched ?? []).some((u) => u.kind === "area")
  );
}

function sameSet<T>(a: T[], b: T[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

export interface GoldenScore {
  n: number;
  correct: number;
  accuracy: number;
  byCategory: Record<string, { n: number; correct: number }>;
  /** The same, over the entries whose text the prompt doesn't quote. */
  unseen: { n: number; correct: number; accuracy: number };
}

/** Aggregate per-entry results into the report's score. */
export function scoreGolden(
  results: { entry: GoldenEntry; correct: boolean }[],
  promptStrings: ReadonlySet<string>,
): GoldenScore {
  const byCategory: GoldenScore["byCategory"] = {};
  let correct = 0;
  let unseenN = 0;
  let unseenCorrect = 0;
  for (const r of results) {
    const c = (byCategory[r.entry.category] ??= { n: 0, correct: 0 });
    c.n++;
    if (r.correct) {
      c.correct++;
      correct++;
    }
    if (!promptStrings.has(r.entry.raw)) {
      unseenN++;
      if (r.correct) unseenCorrect++;
    }
  }
  const n = results.length;
  return {
    n,
    correct,
    accuracy: n === 0 ? 0 : correct / n,
    byCategory,
    unseen: {
      n: unseenN,
      correct: unseenCorrect,
      accuracy: unseenN === 0 ? 0 : unseenCorrect / unseenN,
    },
  };
}
