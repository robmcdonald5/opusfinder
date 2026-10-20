/**
 * Persistence for `location_strings`: which (company, raw) pairs still need the location normalizer, the
 * context it is given, and the upsert of its checked answers. "Active" means a string some active job
 * lists; a blank string is never a pair, and neither is one over {@link MAX_LOCATION_RAW_BYTES}.
 */
import { sql, type SQL } from "drizzle-orm";

import type { LocationConfidence, SourceName, UnmatchedPlace } from "@opusfinder/shared";

import type { Db } from "../client";
import { companies, jobs, locationStrings } from "../schema";
import { intArrayLiteral, resultRows } from "./sql";

/** The longest location string resolved, in bytes. The (company_id, raw) key's btree index rejects a row
 *  past ~2.7 KB, so a longer string is never sent or stored; `locations:report` counts them. upsertJobs
 *  keeps a location to 500 characters (≤ 2,000 bytes), so only another writer can get past it. */
export const MAX_LOCATION_RAW_BYTES = 2000;

/** The text elements of a jobs `locations` column: a set-returning call that yields nothing, instead of
 *  failing the whole query, for a value that isn't a JSON array. */
export function locationTextsSql(column: SQL): SQL {
  return sql`jsonb_array_elements_text(CASE WHEN jsonb_typeof(${column}) = 'array' THEN ${column} END)`;
}

/** A (company, raw) pair's key. */
export interface LocationPairKey {
  companyId: number;
  raw: string;
}

/** A (company, raw) pair some active job lists, with how many active jobs list it. */
export interface LocationPair {
  companyId: number;
  raw: string;
  companySlug: string;
  companySource: SourceName;
  jobs: number;
}

/** A checked normalizer answer, as stored. */
export interface LocationStringRow {
  companyId: number;
  raw: string;
  placeIds: number[];
  remoteCountries: string[];
  unmatched: UnmatchedPlace[];
  confidence: LocationConfidence | null;
  reason: string | null;
  promptVersion: string;
}

/**
 * Pairs to (re)resolve, most-listed first. `missing` = no row yet (the digest's daily path). `stale` also
 * takes rows from another prompt version and rows the model gave no answer for (confidence NULL): the
 * backfill's set. `exclude` leaves out pairs the caller already tried in this run.
 */
export async function listPendingPairs(
  db: Db,
  opts: {
    scope: "missing" | "stale";
    promptVersion: string;
    limit?: number;
    exclude?: LocationPairKey[];
  },
): Promise<LocationPair[]> {
  const pending =
    opts.scope === "missing"
      ? sql`s.company_id IS NULL`
      : sql`(s.company_id IS NULL OR s.prompt_version <> ${opts.promptVersion} OR s.confidence IS NULL)`;
  const excluded =
    opts.exclude && opts.exclude.length > 0
      ? sql`AND NOT EXISTS (
          SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(opts.exclude)}::jsonb) AS x("companyId" int, raw text)
          WHERE x."companyId" = a.company_id AND x.raw = a.raw
        )`
      : sql``;
  const result = await db.execute(sql`
    SELECT a.company_id, a.raw, c.slug, c.source, a.jobs
    FROM (${activePairsSql()}) a
    JOIN ${companies} c ON c.id = a.company_id
    LEFT JOIN ${locationStrings} s ON s.company_id = a.company_id AND s.raw = a.raw
    WHERE ${pending} ${excluded}
    ORDER BY a.jobs DESC, a.company_id, a.raw
    ${opts.limit === undefined ? sql`` : sql`LIMIT ${opts.limit}`}
  `);
  return resultRows(result).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      companyId: Number(r.company_id),
      raw: String(r.raw),
      companySlug: String(r.slug),
      companySource: String(r.source) as SourceName,
      jobs: Number(r.jobs),
    };
  });
}

/** Each company's active location strings, most-listed first, at most `perCompany` each. The normalizer
 *  shows a pair the company's OTHER strings as context, so callers ask for one more than they show. */
export async function listCompanyStrings(
  db: Db,
  companyIds: number[],
  perCompany: number,
): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (companyIds.length === 0) return out;
  const result = await db.execute(sql`
    SELECT company_id, raw FROM (
      SELECT a.company_id, a.raw,
             row_number() OVER (PARTITION BY a.company_id ORDER BY a.jobs DESC, a.raw) AS rn
      FROM (${activePairsSql(sql`AND j.company_id = ANY(${intArrayLiteral(companyIds)}::int[])`)}) a
    ) ranked
    WHERE rn <= ${perCompany}
    ORDER BY company_id, rn
  `);
  for (const row of resultRows(result)) {
    const r = row as Record<string, unknown>;
    const id = Number(r.company_id);
    out.set(id, [...(out.get(id) ?? []), String(r.raw)]);
  }
  return out;
}

const UPSERT_CHUNK = 500;

/** Insert or replace rows by (company_id, raw), stamping resolved_at. A row the model gave no answer for
 *  (confidence NULL) never replaces one it did answer: a re-run that hits a refusal keeps the older answer
 *  (and its older prompt version, so the next backfill tries again). */
export async function upsertLocationStrings(db: Db, rows: LocationStringRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    await db
      .insert(locationStrings)
      .values(rows.slice(i, i + UPSERT_CHUNK))
      .onConflictDoUpdate({
        target: [locationStrings.companyId, locationStrings.raw],
        set: {
          placeIds: sql`excluded.place_ids`,
          remoteCountries: sql`excluded.remote_countries`,
          unmatched: sql`excluded.unmatched`,
          confidence: sql`excluded.confidence`,
          reason: sql`excluded.reason`,
          promptVersion: sql`excluded.prompt_version`,
          resolvedAt: sql`now()`,
        },
        setWhere: sql`excluded.confidence IS NOT NULL OR ${locationStrings.confidence} IS NULL`,
      });
  }
}

/** The (company_id, raw, jobs) pairs of active jobs, as a subquery. `extra` narrows the jobs scanned. */
export function activePairsSql(extra = sql``) {
  return sql`
    SELECT j.company_id, l.raw, count(*)::int AS jobs
    FROM ${jobs} j CROSS JOIN LATERAL ${locationTextsSql(sql`j.locations`)} AS l(raw)
    WHERE j.lifecycle_state = 'active' AND btrim(l.raw) <> ''
      AND octet_length(l.raw) <= ${sql.raw(String(MAX_LOCATION_RAW_BYTES))} ${extra}
    GROUP BY j.company_id, l.raw
  `;
}
