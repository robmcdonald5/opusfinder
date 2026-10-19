/**
 * Read-only queries behind `locations:report` (how well the stored location strings cover active jobs,
 * and the worklist of strings that need a better prompt) and `locations:explain` (why a job is or isn't
 * local for a user). Explain's verdicts come from the location rule's own SQL (location-rule.ts), never a
 * re-implementation.
 */
import { sql } from "drizzle-orm";

import type { LocationConfidence, PlaceKind, SourceName, UnmatchedPlace } from "@opusfinder/shared";

import type { Db } from "../client";
import { companies, jobs, locationStrings, places } from "../schema";
import { activePairsSql } from "./location-strings";
import { locationRule, milesBetween, type LocationFilter } from "./location-rule";
import { candidateFilterSql } from "./retrieval";
import { resultRows, VECTOR_CAST, vectorLiteral } from "./sql";

export interface SourceCoverage {
  source: SourceName;
  onsite: number;
  /** On-site jobs with at least one stored place. */
  onsitePlaced: number;
  remote: number;
}

export interface PairStatus {
  /** Active pairs with no row yet. */
  missing: number;
  /** Rows written by another prompt version. */
  stale: number;
  /** Rows the model gave no usable answer for. */
  unresolved: number;
  /** Active pairs in total. */
  active: number;
}

/** A stored row as the report lists it, with how many active jobs carry it. */
export interface ReportRow {
  companySlug: string;
  raw: string;
  jobs: number;
  confidence: LocationConfidence | null;
  reason: string | null;
  unmatched: UnmatchedPlace[];
}

export type ReportList = "no-place" | "low-confidence" | "unmatched" | "unresolved";

export async function coverageBySource(db: Db): Promise<SourceCoverage[]> {
  const result = await db.execute(sql`
    WITH active AS (
      SELECT id, company_id, source, remote, locations FROM ${jobs} WHERE lifecycle_state = 'active'
    ),
    placed AS (
      SELECT DISTINCT a.id FROM active a
      CROSS JOIN LATERAL jsonb_array_elements_text(a.locations) AS l(raw)
      JOIN ${locationStrings} s ON s.company_id = a.company_id AND s.raw = l.raw
      WHERE cardinality(s.place_ids) > 0
    )
    SELECT a.source,
           count(*) FILTER (WHERE NOT a.remote)::int AS onsite,
           count(*) FILTER (WHERE NOT a.remote AND p.id IS NOT NULL)::int AS onsite_placed,
           count(*) FILTER (WHERE a.remote)::int AS remote
    FROM active a LEFT JOIN placed p ON p.id = a.id
    GROUP BY a.source
    ORDER BY onsite DESC, a.source
  `);
  return resultRows(result).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      source: String(r.source) as SourceName,
      onsite: Number(r.onsite),
      onsitePlaced: Number(r.onsite_placed),
      remote: Number(r.remote),
    };
  });
}

export async function pairStatus(db: Db, promptVersion: string): Promise<PairStatus> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS active,
           count(*) FILTER (WHERE s.company_id IS NULL)::int AS missing,
           count(*) FILTER (WHERE s.prompt_version <> ${promptVersion})::int AS stale,
           count(*) FILTER (WHERE s.company_id IS NOT NULL AND s.confidence IS NULL)::int AS unresolved
    FROM (${activePairsSql()}) a
    LEFT JOIN ${locationStrings} s ON s.company_id = a.company_id AND s.raw = a.raw
  `);
  const r = (resultRows(result)[0] ?? {}) as Record<string, unknown>;
  return {
    active: Number(r.active ?? 0),
    missing: Number(r.missing ?? 0),
    stale: Number(r.stale ?? 0),
    unresolved: Number(r.unresolved ?? 0),
  };
}

/** One of the report's worklists, by active-job count. */
export async function reportList(db: Db, list: ReportList, limit: number): Promise<ReportRow[]> {
  const where = {
    "no-place": sql`s.confidence IS NOT NULL AND cardinality(s.place_ids) = 0 AND cardinality(s.remote_countries) = 0`,
    "low-confidence": sql`s.confidence = 'low'`,
    unmatched: sql`jsonb_array_length(s.unmatched) > 0`,
    unresolved: sql`s.confidence IS NULL`,
  }[list];
  const result = await db.execute(sql`
    SELECT c.slug, s.raw, a.jobs, s.confidence, s.reason, s.unmatched
    FROM ${locationStrings} s
    JOIN (${activePairsSql()}) a ON a.company_id = s.company_id AND a.raw = s.raw
    JOIN ${companies} c ON c.id = s.company_id
    WHERE ${where}
    ORDER BY a.jobs DESC, c.slug, s.raw
    LIMIT ${limit}
  `);
  return resultRows(result).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      companySlug: String(r.slug),
      raw: String(r.raw),
      jobs: Number(r.jobs),
      confidence: (r.confidence ?? null) as LocationConfidence | null,
      reason: r.reason === null ? null : String(r.reason),
      unmatched: parseJsonArray(r.unmatched) as UnmatchedPlace[],
    };
  });
}

/** One of a job's location strings, as stored, with each place's distance from the home. */
export interface ExplainedString {
  raw: string;
  /** False when no row exists yet for this (company, raw). */
  stored: boolean;
  confidence: LocationConfidence | null;
  reason: string | null;
  promptVersion: string | null;
  remoteCountries: string[];
  unmatched: UnmatchedPlace[];
  places: {
    geonamesId: number;
    kind: PlaceKind;
    name: string;
    regionName: string | null;
    countryCode: string;
    lat: number | null;
    lng: number | null;
    /** Miles from the home city; null without a home or for a region/country. */
    miles: number | null;
  }[];
}

export interface ExplainedJob {
  id: number;
  title: string;
  companySlug: string;
  remote: boolean;
  strings: ExplainedString[];
  /** The rule case the job falls in, and whether it passes. */
  verdict: string;
  passes: boolean;
}

/** A job's location strings and the rule's verdict for this user. Null when no such job exists. */
export async function explainJob(
  db: Db,
  jobId: number,
  filter: LocationFilter,
): Promise<ExplainedJob | null> {
  const rule = locationRule(filter, sql`j.id = ${jobId}`);
  const jobResult = await db.execute(sql`
    ${rule.ctes ? sql`WITH ${rule.ctes}` : sql``}
    SELECT j.id, j.title, j.remote, j.locations, c.slug,
           ${rule.verdict} AS verdict, ${rule.passes ?? sql`true`} AS passes
    FROM ${jobs} j
    JOIN ${companies} c ON c.id = j.company_id
    ${rule.join ?? sql``}
    WHERE j.id = ${jobId}
  `);
  const job = resultRows(jobResult)[0] as Record<string, unknown> | undefined;
  if (!job) return null;

  const home = filter.home
    ? sql`(SELECT lat, lng FROM ${places} WHERE geonames_id = ${filter.home.placeId})`
    : sql`(SELECT NULL::float8 AS lat, NULL::float8 AS lng)`;
  const miles = milesBetween(sql`h.lat`, sql`h.lng`, sql`p.lat`, sql`p.lng`);
  const stringResult = await db.execute(sql`
    SELECT l.raw, l.ord, s.company_id IS NOT NULL AS stored, s.confidence, s.reason, s.prompt_version,
           s.remote_countries, s.unmatched,
           COALESCE(json_agg(json_build_object(
             'geonamesId', p.geonames_id, 'kind', p.kind, 'name', p.name, 'regionName', p.region_name,
             'countryCode', p.country_code, 'lat', p.lat, 'lng', p.lng,
             'miles', CASE WHEN p.kind = 'city' THEN round((${miles})::numeric, 1) END
           ) ORDER BY u.ord) FILTER (WHERE p.geonames_id IS NOT NULL), '[]') AS places
    FROM ${jobs} j
    CROSS JOIN LATERAL jsonb_array_elements_text(j.locations) WITH ORDINALITY AS l(raw, ord)
    CROSS JOIN ${home} h
    LEFT JOIN ${locationStrings} s ON s.company_id = j.company_id AND s.raw = l.raw
    LEFT JOIN LATERAL unnest(s.place_ids) WITH ORDINALITY AS u(place_id, ord) ON true
    LEFT JOIN ${places} p ON p.geonames_id = u.place_id
    WHERE j.id = ${jobId}
    GROUP BY l.raw, l.ord, s.company_id, s.confidence, s.reason, s.prompt_version, s.remote_countries, s.unmatched
    ORDER BY l.ord
  `);
  return {
    id: Number(job.id),
    title: String(job.title),
    companySlug: String(job.slug),
    remote: job.remote === true,
    verdict: String(job.verdict),
    passes: job.passes === true,
    strings: resultRows(stringResult).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        raw: String(r.raw),
        stored: r.stored === true,
        confidence: (r.confidence ?? null) as LocationConfidence | null,
        reason: r.reason === null || r.reason === undefined ? null : String(r.reason),
        promptVersion:
          r.prompt_version === null || r.prompt_version === undefined
            ? null
            : String(r.prompt_version),
        remoteCountries: Array.isArray(r.remote_countries) ? r.remote_countries.map(String) : [],
        unmatched: parseJsonArray(r.unmatched) as UnmatchedPlace[],
        places: (parseJsonArray(r.places) as Record<string, unknown>[]).map((p) => ({
          geonamesId: Number(p.geonamesId),
          kind: String(p.kind) as PlaceKind,
          name: String(p.name),
          regionName: p.regionName === null ? null : String(p.regionName),
          countryCode: String(p.countryCode),
          lat: p.lat === null ? null : Number(p.lat),
          lng: p.lng === null ? null : Number(p.lng),
          miles: p.miles === null || p.miles === undefined ? null : Number(p.miles),
        })),
      };
    }),
  };
}

/**
 * Where a job ranks by cosine distance among the user's candidates with location ignored (the same
 * candidate filter retrieval uses, minus the location rule): 1 = closest. Null when the job is not a
 * candidate at all (closed, unembedded, outside the recency window).
 */
export async function cosineRankIgnoringLocation(
  db: Db,
  embedding: number[],
  jobId: number,
  recencyDays: number,
): Promise<number | null> {
  const literal = vectorLiteral(embedding);
  const filter = candidateFilterSql({ recencyDays });
  const result = await db.execute(sql`
    WITH target AS (
      SELECT j.embedding <=> ${literal}${VECTOR_CAST} AS distance FROM ${jobs} j WHERE j.id = ${jobId} AND ${filter}
    )
    SELECT 1 + (SELECT count(*) FROM (
      SELECT j.embedding <=> ${literal}${VECTOR_CAST} AS distance, j.id FROM ${jobs} j WHERE ${filter} OFFSET 0
    ) c WHERE c.distance < t.distance OR (c.distance = t.distance AND c.id < ${jobId}))::int AS rank
    FROM target t
  `);
  const row = resultRows(result)[0] as { rank?: unknown } | undefined;
  return row ? Number(row.rank) : null;
}

/** neon-http returns json/jsonb pre-parsed; PGlite may hand back a string. */
function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  }
  return [];
}
