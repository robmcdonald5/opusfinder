/**
 * The GeoNames check: every place the model names must exist in `places`, or it is dropped and kept on
 * the row's `unmatched` list. The country must be a known ISO code; a region matches by its code or name
 * within that country; a city by its name or ASCII name (else an alternate name) within that region, or
 * within the country when no region was given or the given one isn't a GeoNames region name ("County
 * Dublin", "State of Berlin"). A region that IS one GeoNames knows but holds no such city fails: that is
 * a wrong state, not a spelling. The one exception is a region named exactly like the city ("Taipei,
 * Taipei", "Buenos Aires, Buenos Aires"): that names the city's own municipality, which GeoNames sometimes
 * files under another region, so the city is looked up across the country. Two same-named cities in one
 * scope: the larger wins.
 */
import type { Db } from "@opusfinder/db";
import {
  cityKey,
  findCities,
  listCountriesAndRegions,
  type CityMatch,
  type Place,
} from "@opusfinder/db/repos";
import { normalizePlaceName, type UnmatchedPlace } from "@opusfinder/shared";

import type { AnsweredPlace, LocationAnswerValue } from "./schema";

/** Countries by ISO code and each country's regions: ~4k rows, loaded once per run. */
export interface Gazetteer {
  countries: ReadonlyMap<string, Place>;
  regions: ReadonlyMap<string, Place[]>;
}

/** An answer after the check: the place ids that exist, the valid remote countries, and what failed. */
export interface CheckedAnswer {
  placeIds: number[];
  remoteCountries: string[];
  unmatched: UnmatchedPlace[];
}

export async function loadGazetteer(db: Db): Promise<Gazetteer> {
  const countries = new Map<string, Place>();
  const regions = new Map<string, Place[]>();
  for (const place of await listCountriesAndRegions(db)) {
    if (place.kind === "country") countries.set(place.countryCode, place);
    else regions.set(place.countryCode, [...(regions.get(place.countryCode) ?? []), place]);
  }
  if (countries.size === 0) {
    throw new Error(
      "The places table is empty: run `pnpm --filter @opusfinder/db run places:load` first.",
    );
  }
  return { countries, regions };
}

/** Check a set of answers, with one city lookup for all of them. Order is preserved. */
export async function checkAnswers(
  db: Db,
  gazetteer: Gazetteer,
  answers: LocationAnswerValue[],
): Promise<CheckedAnswer[]> {
  const keys = answers.flatMap((a) =>
    a.places.flatMap((p) =>
      p.city ? [{ countryCode: countryCode(p), nameNorm: normalizePlaceName(p.city) }] : [],
    ),
  );
  const cities = new Map<string, CityMatch[]>();
  for (const match of await findCities(db, keys)) {
    cities.set(match.key, [...(cities.get(match.key) ?? []), match]);
  }
  return answers.map((answer) => checkAnswer(answer, gazetteer, cities));
}

function checkAnswer(
  answer: LocationAnswerValue,
  gazetteer: Gazetteer,
  cities: ReadonlyMap<string, CityMatch[]>,
): CheckedAnswer {
  const placeIds = new Set<number>();
  const unmatched: UnmatchedPlace[] = [];
  for (const place of answer.places) {
    const fail = (why: UnmatchedPlace["why"]) =>
      unmatched.push({
        city: place.city,
        region: place.region,
        country: place.country,
        kind: place.kind,
        why,
      });
    const code = countryCode(place);
    const country = gazetteer.countries.get(code);
    if (!country) {
      fail("unknown-country");
      continue;
    }
    const region = place.region ? findRegion(gazetteer, code, place.region) : null;
    if (place.city) {
      const cityNorm = normalizePlaceName(place.city);
      const matches = cities.get(cityKey(code, cityNorm)) ?? [];
      const city =
        pickCity(matches, region) ??
        (region && normalizePlaceName(place.region ?? "") === cityNorm
          ? pickCity(matches, null)
          : null);
      if (city) placeIds.add(city.geonamesId);
      else fail("unknown-city");
    } else if (place.region) {
      if (region) placeIds.add(region.geonamesId);
      else fail("unknown-region");
    } else {
      placeIds.add(country.geonamesId);
    }
  }

  const remoteCountries = new Set<string>();
  for (const raw of answer.remoteCountries) {
    const code = raw.trim().toUpperCase();
    if (gazetteer.countries.has(code)) remoteCountries.add(code);
    else
      unmatched.push({
        city: null,
        region: null,
        country: raw,
        kind: "country",
        why: "unknown-country",
      });
  }
  return { placeIds: [...placeIds], remoteCountries: [...remoteCountries], unmatched };
}

function countryCode(place: AnsweredPlace): string {
  return place.country.trim().toUpperCase();
}

/** A region of the country by code ("OH", "ENG") or by name ("Ohio", "Île-de-France"). */
function findRegion(gazetteer: Gazetteer, country: string, text: string): Place | null {
  const code = text.trim().toUpperCase();
  const norm = normalizePlaceName(text);
  const regions = gazetteer.regions.get(country) ?? [];
  return (
    regions.find((r) => r.regionCode?.toUpperCase() === code) ??
    regions.find((r) => r.nameNorm === norm || r.asciiNorm === norm) ??
    null
  );
}

/** The largest city matching by name in scope, else the largest matching by alternate name. Ties go to
 *  the lower geonames id, so the answer is stable. */
function pickCity(matches: CityMatch[], region: Place | null): CityMatch | null {
  const inScope = region ? matches.filter((m) => m.regionCode === region.regionCode) : matches;
  const byName = inScope.filter((m) => !m.byAlt);
  const pool = byName.length > 0 ? byName : inScope.filter((m) => m.byAlt);
  let best: CityMatch | null = null;
  for (const m of pool) {
    if (
      !best ||
      m.population > best.population ||
      (m.population === best.population && m.geonamesId < best.geonamesId)
    ) {
      best = m;
    }
  }
  return best;
}
