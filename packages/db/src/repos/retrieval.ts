/**
 * Phase-10 digest retrieval: the deterministic filter + cosine nearest-neighbour query that turns a
 * user's profile embedding into a ranked candidate set. Kept separate from the Phase-4 embeddings
 * backfill machinery (embeddings.ts) so the digest read path is self-contained.
 *
 * Reuses nearestJobs's exact cosine pattern (bind the query vector ONCE, compute `<=>` in the
 * projection, ORDER BY the distance alias so the HNSW path still matches at scale) and layers the
 * deterministic predicates on top. SQL handles the cheap, plannable filters (has-embedding, active,
 * recency, already-shown exclusions). The remote/location geo filter AND the free-form exclusion
 * keywords are applied APP-SIDE after an OVER-FETCH because (a) jobs.locations is jsonb and user prefs
 * are a string[] needing fuzzy overlap, and (b) over-fetch+trim is the guard against pgvector HNSW
 * returning fewer than `limit` rows once a selective WHERE post-filters the ef_search-bounded candidate
 * set (filtered-ANN under-fill). Both post-filters run BEFORE the trim, so they draw on the whole
 * over-fetch buffer instead of shrinking the returned set below `limit`.
 *
 * NOTE on ef_search: `SET LOCAL hnsw.ef_search` cannot be honored over the neon-http driver (it is
 * autocommit + stateless per request, so a SET does not span the follow-up query). Over-fetch is the
 * recall guard for now; the table currently seq-scans regardless of HNSW. Revisit (a neon-serverless
 * transaction, or pgvector iterative scan) only once the jobs table is large enough that recall under a
 * selective filter measurably drops — validate with EXPLAIN then.
 */
import { sql } from "drizzle-orm";

import type { Db } from "../client";
import { jobs } from "../schema";
import { intArrayLiteral, resultRows, VECTOR_CAST, vectorLiteral } from "./sql";

export interface RetrieveOpts {
  /** Final candidate count returned (default 50). */
  limit?: number;
  /** SQL fetch multiplier before the app-side post-filters (geo + exclusions) trim to `limit`
   *  (default 3). Guards against those filters — and pgvector's filtered-ANN post-filtering —
   *  under-filling the result. */
  overFetch?: number;
  /** From user_preferences: accept remote jobs (default true). When false, remote jobs are excluded. */
  remoteOk?: boolean;
  /** From user_preferences: preferred location strings; empty = no location constraint. */
  locations?: string[];
  /** From user_preferences: max posting age in days, measured on COALESCE(posted_at, created_at) (default 14). */
  recencyDays?: number;
  /** From user_preferences: free-form exclusion keywords. A candidate whose title or description
   *  matches any term (whole-word, case-insensitive) is dropped in the app-side post-filter, before
   *  the over-fetch trim. */
  exclusions?: string[];
  /** Already-shown job ids to exclude (the digest_items anti-join feeds this). */
  excludeJobIds?: number[];
}

export interface JobCandidate {
  id: number;
  title: string;
  descriptionText: string;
  locations: string[];
  remote: boolean;
  /** Cosine distance from the profile vector (`<=>`); smaller is closer. */
  distance: number;
}

/**
 * The top candidate jobs for a profile embedding, deterministically filtered then cosine-ranked.
 * `minSalary` is intentionally NOT a filter — jobs carry no salary column (Phase-10 decision).
 */
export async function retrieveCandidatesForProfile(
  db: Db,
  embedding: number[],
  opts: RetrieveOpts = {},
): Promise<JobCandidate[]> {
  const limit = opts.limit ?? 50;
  // Floor at 1 so an explicit overFetch=0/negative can't produce LIMIT 0 (silently returning []).
  const overFetch = Math.max(1, opts.overFetch ?? 3);
  const remoteOk = opts.remoteOk ?? true;
  const locations = opts.locations ?? [];
  const recencyDays = opts.recencyDays ?? 14;
  const exclusions = compileExclusions(opts.exclusions ?? []);
  const excludeJobIds = opts.excludeJobIds ?? [];
  const fetchLimit = limit * overFetch;

  const literal = vectorLiteral(embedding); // asserts the 1024-dim width up front

  const conditions = [
    sql`embedding IS NOT NULL`,
    sql`lifecycle_state = 'active'`,
    // posted_at is nullable — fall back to created_at so a NULL-posted job is not silently dropped.
    // `${n} * interval '1 day'` is the repo idiom (discovery.ts) and handles any numeric recencyDays.
    sql`COALESCE(posted_at, created_at) >= now() - ${recencyDays} * interval '1 day'`,
  ];
  if (excludeJobIds.length > 0) {
    // One bound text param cast to int[] — avoids the 65535 bind-param ceiling for a large anti-join.
    const arrayLiteral = intArrayLiteral(excludeJobIds);
    conditions.push(sql`id <> ALL(${arrayLiteral}::int[])`);
  }
  const whereClause = sql.join(conditions, sql` AND `);

  // Bind the query vector once (the distance alias keeps the HNSW sort pathkey — see nearestJobs).
  const result: unknown = await db.execute(sql`
    SELECT id, title, description_text, locations, remote,
           embedding <=> ${literal}${VECTOR_CAST} AS distance
    FROM ${jobs}
    WHERE ${whereClause}
    ORDER BY distance
    LIMIT ${fetchLimit}
  `);

  const candidates = resultRows(result).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: Number(r.id),
      title: typeof r.title === "string" ? r.title : String(r.title),
      descriptionText:
        typeof r.description_text === "string" ? r.description_text : String(r.description_text ?? ""),
      locations: parseLocations(r.locations),
      // neon-http returns a bool column as a JS boolean.
      remote: r.remote === true,
      distance: Number(r.distance),
    } satisfies JobCandidate;
  });

  // App-side geo + exclusion filters, then trim to `limit` (see the file header for why app-side).
  return candidates
    .filter((c) => geoMatches(c, remoteOk, locations) && !isExcluded(c, exclusions))
    .slice(0, limit);
}

/**
 * Compile exclusion keywords into whole-word, case-insensitive matchers. Substring matching is NOT
 * safe here: a short term like "ai" hides inside "email"/"daily"/"training" and would silently
 * annihilate the whole candidate pool. `\b` anchors are added only against word-character edges, so a
 * term ending in a symbol ("c++") still matches.
 */
function compileExclusions(exclusions: string[]): RegExp[] {
  return exclusions
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
    .map((e) => {
      const escaped = e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const lead = /^\w/.test(e) ? "\\b" : "";
      const tail = /\w$/.test(e) ? "\\b" : "";
      return new RegExp(`${lead}${escaped}${tail}`, "i");
    });
}

function isExcluded(job: JobCandidate, exclusions: RegExp[]): boolean {
  if (exclusions.length === 0) return false;
  const hay = `${job.title}\n${job.descriptionText}`;
  return exclusions.some((re) => re.test(hay));
}

/**
 * v1 geo match: a remote job passes iff the user accepts remote; an on-site job passes iff the user set
 * no location constraint, OR the job has no location data (unknown ≠ mismatch — ATS feeds often leave
 * locations empty, putting it in the description; dropping these would silently tank recall, so include
 * and let rerank/synthesis judge), OR one of the user's locations overlaps a job location. A
 * heuristic — the exact rule firms up with the Phase-12 onboarding form.
 */
function geoMatches(job: JobCandidate, remoteOk: boolean, locations: string[]): boolean {
  if (job.remote) return remoteOk;
  const wanted = locations.map((l) => l.toLowerCase().trim()).filter((l) => l.length > 0);
  if (wanted.length === 0) return true;
  const have = job.locations.map((l) => l.toLowerCase().trim());
  if (have.length === 0) return true; // unknown location — don't exclude
  return have.some((h) => wanted.some((w) => locationOverlaps(h, w)));
}

/** Case-folded location overlap: exact match, or containment when the CONTAINED side is ≥4 chars —
 *  "san francisco" ↔ "san francisco, ca" matches either way round, but a bare token like "ca" only
 *  matches exactly (substring would false-match inside "chicago"). */
function locationOverlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (b.length >= 4 && a.includes(b)) return true;
  if (a.length >= 4 && b.includes(a)) return true;
  return false;
}

/** jobs.locations is jsonb<string[]>, NOT NULL default []; neon-http returns it pre-parsed as an array. */
function parseLocations(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}
