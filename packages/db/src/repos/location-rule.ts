/**
 * The location rule — the whole digest location filter, as SQL. Retrieval puts it in its WHERE, so a job
 * the rule drops never has its cosine distance computed; `locations:explain` reads the same cases back as
 * verdict labels. One builder for both, so an explanation can't drift from what retrieval does.
 *
 * 1. No home place: only `location_mode` applies (remote_only → remote jobs, onsite_only → on-site jobs).
 * 2. Remote job (unless the user is on-site only): passes if it names no country, or names the user's.
 *    "Names a country" = any country among its strings' places or remote countries, so plain "Remote"
 *    passes for everyone and "Remote, Türkiye" only for users in Türkiye.
 * 3. On-site job (unless the user is remote only): passes if one of its places is a city within the
 *    user's radius, or it names the user's region and no city in that region (the most specific place
 *    wins: "Dallas, TX" + "Texas" is a Dallas job).
 * Everything else is not local: no usable place (unresolved, "Hybrid", no strings), on-site country-only,
 * remote open only to other countries.
 *
 * Per user, `string_flags` works out once what every location string means relative to the home (a
 * MATERIALIZED CTE, computed once per query), and `job_flags` folds those onto each job through its raw
 * `locations` with a hash join. A job's strings are matched by exact text within its company, the
 * location_strings key.
 */
import { sql, type SQL } from "drizzle-orm";

import type { LocationMode } from "@opusfinder/shared";

import { jobs, locationStrings, places } from "../schema";

/** Earth's mean radius in miles, for the haversine distance. */
export const EARTH_RADIUS_MILES = 3958.8;

/** The user's side of the rule. */
export interface LocationFilter {
  mode: LocationMode;
  home: { placeId: number; radiusMiles: number } | null;
}

/** The rule's SQL, for a query over `jobs j`. `ctes` (the WITH body) and `join` are null when the rule
 *  needs no place data (no home); `passes` is null when every job passes. */
export interface LocationRuleSql {
  ctes: SQL | null;
  join: SQL | null;
  passes: SQL | null;
  /** The label of the case a job falls in — what locations:explain prints. */
  verdict: SQL;
}

interface RuleCase {
  /** null = the CASE's ELSE. */
  when: SQL | null;
  pass: boolean;
  label: string;
}

/** Great-circle distance in miles between two points given as SQL lat/lng expressions (degrees). */
export function milesBetween(lat1: SQL, lng1: SQL, lat2: SQL, lng2: SQL): SQL {
  return sql`(2 * ${sql.raw(String(EARTH_RADIUS_MILES))} * asin(least(1, sqrt(
    power(sin(radians(${lat2} - ${lat1}) / 2), 2)
    + cos(radians(${lat1})) * cos(radians(${lat2})) * power(sin(radians(${lng2} - ${lng1}) / 2), 2)
  ))))`;
}

/**
 * Build the rule for one user. `jobFilter` is the WHERE over `jobs j` that bounds which jobs `job_flags`
 * folds (retrieval passes its own filters, so no job outside the candidate set is scanned twice).
 */
export function locationRule(filter: LocationFilter, jobFilter: SQL): LocationRuleSql {
  const cases = ruleCases(filter);
  const passes = cases.every((c) => c.pass) ? null : caseSql(cases, (c) => sql.raw(String(c.pass)));
  const verdict = caseSql(cases, (c) => sql`${c.label}::text`);
  if (!filter.home) return { ctes: null, join: null, passes, verdict };
  return {
    ctes: sql`${homeAndStringFlagsSql(filter.home)},
    job_flags AS (
      SELECT j.id AS job_id,
             bool_or(f.near_city) AS near_city,
             bool_or(f.home_region) AS home_region,
             bool_or(f.city_in_home_region) AS city_in_home_region,
             bool_or(f.home_country) AS home_country,
             bool_or(f.names_country) AS names_country
      FROM ${jobs} j
      CROSS JOIN LATERAL jsonb_array_elements_text(j.locations) AS l(raw)
      JOIN string_flags f ON f.company_id = j.company_id AND f.raw = l.raw
      WHERE ${jobFilter}
      GROUP BY j.id
    )`,
    join: sql`LEFT JOIN job_flags jf ON jf.job_id = j.id`,
    passes,
    verdict,
  };
}

/**
 * The `home` and `string_flags` CTEs (without the WITH keyword): per location string, whether it names
 * a city within the radius, the home region, a city in the home region, the home country, any country.
 * Exported for the per-string breakdown in locations:explain and the digest's local-string count.
 */
export function homeAndStringFlagsSql(home: { placeId: number; radiusMiles: number }): SQL {
  const miles = milesBetween(sql`h.lat`, sql`h.lng`, sql`p.lat`, sql`p.lng`);
  return sql`home AS (
      SELECT p.lat, p.lng, p.region_code, p.country_code FROM ${places} p
      WHERE p.geonames_id = ${home.placeId}
    ),
    string_flags AS MATERIALIZED (
      SELECT s.company_id, s.raw,
             COALESCE(bool_or(p.kind = 'city' AND ${miles} <= ${home.radiusMiles}::float8), false) AS near_city,
             COALESCE(bool_or(p.kind = 'region' AND p.country_code = h.country_code
                              AND p.region_code = h.region_code), false) AS home_region,
             COALESCE(bool_or(p.kind = 'city' AND p.country_code = h.country_code
                              AND p.region_code = h.region_code), false) AS city_in_home_region,
             (COALESCE(bool_or(p.country_code = h.country_code), false)
              OR h.country_code = ANY(s.remote_countries)) AS home_country,
             (count(p.geonames_id) > 0 OR cardinality(s.remote_countries) > 0) AS names_country
      FROM ${locationStrings} s
      CROSS JOIN home h
      LEFT JOIN LATERAL unnest(s.place_ids) AS u(place_id) ON true
      LEFT JOIN ${places} p ON p.geonames_id = u.place_id
      GROUP BY s.company_id, s.raw, s.remote_countries, h.country_code
    )`;
}

/** The ordered cases. Remote cases come first and end in a remote catch-all, so the on-site cases only
 *  ever see on-site jobs. Mode is known here, so only the cases it can reach are emitted. */
function ruleCases({ mode, home }: LocationFilter): RuleCase[] {
  const cases: RuleCase[] = [];
  if (mode === "onsite_only") {
    cases.push({ when: sql`j.remote`, pass: false, label: "remote job; you want on-site only" });
  } else if (!home) {
    cases.push({ when: sql`j.remote`, pass: true, label: "remote job (no home place set)" });
  } else {
    cases.push(
      {
        when: sql`j.remote AND NOT COALESCE(jf.names_country, false)`,
        pass: true,
        label: "remote job naming no country",
      },
      {
        when: sql`j.remote AND jf.home_country`,
        pass: true,
        label: "remote job open to your country",
      },
      { when: sql`j.remote`, pass: false, label: "remote job open only to other countries" },
    );
  }
  if (mode === "remote_only") {
    cases.push({ when: null, pass: false, label: "on-site job; you want remote only" });
  } else if (!home) {
    cases.push({ when: null, pass: true, label: "on-site job (no home place set)" });
  } else {
    cases.push(
      {
        when: sql`jf.near_city`,
        pass: true,
        label: `on-site job with a city within ${home.radiusMiles} mi`,
      },
      {
        when: sql`jf.home_region AND NOT jf.city_in_home_region`,
        pass: true,
        label: "on-site job naming your region and no city in it",
      },
      {
        when: sql`jf.home_region`,
        pass: false,
        label: `on-site job naming a city in your region beyond ${home.radiusMiles} mi`,
      },
      {
        when: sql`NOT COALESCE(jf.names_country, false)`,
        pass: false,
        label: "on-site job with no usable place",
      },
      { when: null, pass: false, label: "on-site job with no place near you" },
    );
  }
  return cases;
}

function caseSql(cases: RuleCase[], value: (c: RuleCase) => SQL): SQL {
  const parts = cases.map((c) =>
    c.when === null ? sql`ELSE ${value(c)}` : sql`WHEN ${c.when} THEN ${value(c)}`,
  );
  return sql`(CASE ${sql.join(parts, sql` `)} END)`;
}
