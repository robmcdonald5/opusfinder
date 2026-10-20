/**
 * The GeoNames check: every place the model names must exist in `places`, or it is dropped and kept on
 * the row's `unmatched` list. The country must be a known ISO code; a region matches by its code or name
 * within that country; a city by its name or ASCII name (else an alternate name) within that region, or
 * within the country when no region was given or the given one isn't a GeoNames region name ("County
 * Dublin", "State of Berlin"). A region that IS one GeoNames knows but holds no such city fails: that is
 * a wrong state, not a spelling. The one exception is a region named exactly like the city ("Taipei,
 * Taipei", "Buenos Aires, Buenos Aires"): that names the city's own municipality, which GeoNames sometimes
 * files under another region, so the city is looked up across the country. Two same-named cities in one
 * scope: the larger wins. A place that fails keeps the country and region codes that did check, for the
 * location rule. Areas expand to their countries (areas.ts) among the remote countries; an area not on the
 * list is kept as unmatched.
 *
 * Spelling tolerance (names.ts), all within the same scopes: a region name also matches without the words
 * that only say it is a region ("Ogun" is GeoNames' "Ogun State", "Haifa District" its "Haifa"), and so
 * does the namesake rule ("Almaty, Almaty Region"); "St."/"Saint", "Mt."/"Mount" and "Ft."/"Fort" match
 * either way; and a hyphenated compound GeoNames doesn't list whole matches by its first or last part, but
 * only inside a region the check knows ("Wals-Siezenheim, Salzburg" → Wals).
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

import { areaCountries } from "./areas";
import { compoundParts, nameVariants, regionCore } from "./names";
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
      p.city
        ? cityNames(p.city).map((nameNorm) => ({ countryCode: countryCode(p), nameNorm }))
        : [],
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
    const code = countryCode(place);
    const country = gazetteer.countries.get(code);
    const region = country && place.region ? findRegion(gazetteer, code, place.region) : null;
    const fail = (why: "unknown-country" | "unknown-region" | "unknown-city") =>
      unmatched.push({
        kind: place.kind,
        city: place.city,
        region: place.region,
        country: place.country,
        why,
        countryCode: country ? code : null,
        regionCode: region?.regionCode ?? null,
      });
    if (!country) {
      fail("unknown-country");
      continue;
    }
    if (place.city) {
      const cityNorm = normalizePlaceName(place.city);
      const lookup = (norms: string[]) => norms.flatMap((n) => cities.get(cityKey(code, n)) ?? []);
      const matches = lookup([cityNorm, ...nameVariants(cityNorm)]);
      const regionNorm = normalizePlaceName(place.region ?? "");
      const namesake = region !== null && [regionNorm, regionCore(regionNorm)].includes(cityNorm);
      const city =
        pickCity(matches, region) ??
        (namesake ? pickCity(matches, null) : null) ??
        (region
          ? compoundParts(place.city, normalizePlaceName)
              .map((part) => pickCity(lookup([part]), region))
              .find((m) => m !== null)
          : null) ??
        null;
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
        kind: "country",
        city: null,
        region: null,
        country: raw,
        why: "unknown-country",
        countryCode: null,
        regionCode: null,
      });
  }
  for (const name of answer.areas) {
    const covered = areaCountries(name);
    if (!covered) {
      unmatched.push({ kind: "area", name: name.trim().slice(0, 100), why: "unknown-area" });
      continue;
    }
    for (const code of covered) if (gazetteer.countries.has(code)) remoteCountries.add(code);
  }
  return { placeIds: [...placeIds], remoteCountries: [...remoteCountries], unmatched };
}

/** One unmatched entry as the CLIs print it. */
export function describeUnmatched(u: UnmatchedPlace): string {
  const what =
    u.kind === "area" ? u.name : [u.city, u.region, u.country].filter(Boolean).join(", ");
  return `${what} (${u.why})`;
}

function countryCode(place: AnsweredPlace): string {
  return place.country.trim().toUpperCase();
}

/** Every name a city is looked up under: its own, its "St."/"Saint" spellings, and its compound parts. */
function cityNames(city: string): string[] {
  const norm = normalizePlaceName(city);
  return [norm, ...nameVariants(norm), ...compoundParts(city, normalizePlaceName)];
}

/** A region of the country by code ("OH", "ENG"), by name ("Ohio", "Île-de-France", "Saint Gallen" for
 *  "St. Gallen"), else by its name without the admin words when that picks exactly one region ("Ogun" →
 *  "Ogun State", "Riyadh Province" → "Riyadh Region"). */
function findRegion(gazetteer: Gazetteer, country: string, text: string): Place | null {
  const code = text.trim().toUpperCase();
  const norm = normalizePlaceName(text);
  const names = [norm, ...nameVariants(norm)];
  const regions = gazetteer.regions.get(country) ?? [];
  const byCode = regions.find((r) => r.regionCode?.toUpperCase() === code);
  if (byCode) return byCode;
  const byName = regions.find((r) => names.includes(r.nameNorm) || names.includes(r.asciiNorm));
  if (byName) return byName;
  const cores = new Set(names.map(regionCore));
  const byCore = regions.filter(
    (r) => cores.has(regionCore(r.nameNorm)) || cores.has(regionCore(r.asciiNorm)),
  );
  return byCore.length === 1 ? byCore[0]! : null;
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
