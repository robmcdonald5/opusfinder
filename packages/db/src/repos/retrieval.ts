/**
 * Digest retrieval: the deterministic filter + cosine nearest-neighbour query that turns a user's profile
 * embedding into a ranked candidate set. Kept separate from the embeddings backfill machinery
 * (embeddings.ts) so the digest read path is self-contained.
 *
 * SQL handles the plannable filters (has-embedding, active, recency, already-shown exclusions), the
 * location rule (location-rule.ts) and the cosine ranking. Only the free-form exclusion keywords are
 * applied APP-SIDE, after an OVER-FETCH, before the trim, so they draw on the whole over-fetch buffer
 * instead of shrinking the returned set below `limit`.
 *
 * EXACT SCAN, ON PURPOSE: the distance is computed in an `OFFSET 0` subquery, which Postgres doesn't
 * flatten, so the outer sort is on a plain column jobs_embedding_hnsw_idx can't serve and the planner
 * never takes the index. On the index, pgvector returns only ~hnsw.ef_search (default 40) nearest rows
 * and the active + recency filter runs after it; `pnpm eval:hnsw` measured that filtered fetch at ~3 of
 * 150 rows, and no over-fetch can fill a set the index never returns. The exact scan computes distances
 * only for rows the filters (location rule included) keep. If ANN is ever needed, `db.batch([SET LOCAL
 * hnsw.iterative_scan…, query])` runs in one transaction on neon-http (PGlite has no batch).
 */
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../client";
import { jobs } from "../schema";
import { homeAndStringFlagsSql, locationRule, type LocationFilter } from "./location-rule";
import { intArrayLiteral, resultRows, textArrayLiteral, VECTOR_CAST, vectorLiteral } from "./sql";

export interface RetrieveOpts {
  /** Final candidate count returned (default 50). */
  limit?: number;
  /** SQL fetch multiplier before the app-side exclusion filter + signature collapse trim to `limit`
   *  (default 3). Guards against those under-filling the result. */
  overFetch?: number;
  /** From user_preferences: location mode + home place (default: mode "any", no home = no location
   *  constraint). Applied in SQL by the location rule. */
  location?: LocationFilter;
  /** From user_preferences: max posting age in days, measured on COALESCE(posted_at, created_at) (default 14). */
  recencyDays?: number;
  /** From user_preferences: free-form exclusion keywords. A candidate whose title or description
   *  matches any term (whole-word, case-insensitive) is dropped in the app-side post-filter, before
   *  the over-fetch trim. */
  exclusions?: string[];
  /** Already-shown job ids to exclude (the digest_items anti-join feeds this). */
  excludeJobIds?: number[];
  /** Already-shown content signatures to exclude — the repost anti-join (alreadyShownSignatures feeds
   *  this). A re-listed role gets a fresh external_id → a new job_id the id anti-join can't see, but the
   *  SAME content_signature; this suppresses it. A NULL-signature candidate is never excluded by it. */
  excludeSignatures?: string[];
}

export interface JobCandidate {
  id: number;
  title: string;
  descriptionText: string;
  /** The content-dedup signature (md5 of normalized title+desc), or NULL for a blank description. Drives the
   *  same-signature display collapse. NOT forwarded into Inngest step state — the retrieve step
   *  deliberately returns only id/title/description; this stays a local retrieval field. */
  contentSignature: string | null;
  /** Cosine distance from the profile vector (`<=>`); smaller is closer. */
  distance: number;
}

/**
 * The top candidate jobs for a profile embedding, deterministically filtered then cosine-ranked.
 * `minSalary` is intentionally NOT a filter — jobs carry no salary column.
 */
export async function retrieveCandidatesForProfile(
  db: Db,
  embedding: number[],
  opts: RetrieveOpts = {},
): Promise<JobCandidate[]> {
  const limit = opts.limit ?? 50;
  // Floor at 1 so an explicit overFetch=0/negative can't produce LIMIT 0 (silently returning []).
  const overFetch = Math.max(1, opts.overFetch ?? 3);
  const exclusions = compileExclusions(opts.exclusions ?? []);
  const fetchLimit = limit * overFetch;

  const literal = vectorLiteral(embedding); // asserts the 1024-dim width up front

  const filter = candidateFilterSql(opts);
  const rule = locationRule(opts.location ?? { mode: "any", home: null }, filter);

  // The query vector is bound once, in the inner projection; `OFFSET 0` keeps the plan an exact scan (see
  // the header) and computes `<=>` once per row the filters and the location rule keep. `id` breaks the
  // exact ties of same-signature cross-posts (identical text, identical embedding), so
  // collapseBySignature keeps the same representative run to run.
  const result: unknown = await db.execute(sql`
    ${rule.ctes ? sql`WITH ${rule.ctes}` : sql``}
    SELECT * FROM (
      SELECT j.id, j.title, j.description_text, j.content_signature,
             j.embedding <=> ${literal}${VECTOR_CAST} AS distance
      FROM ${jobs} j
      ${rule.join ?? sql``}
      WHERE ${filter}${rule.passes ? sql` AND ${rule.passes}` : sql``}
      OFFSET 0
    ) candidates
    ORDER BY distance, id
    LIMIT ${fetchLimit}
  `);

  const candidates = resultRows(result).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: Number(r.id),
      title: typeof r.title === "string" ? r.title : String(r.title),
      descriptionText:
        typeof r.description_text === "string" ? r.description_text : String(r.description_text ?? ""),
      contentSignature: typeof r.content_signature === "string" ? r.content_signature : null,
      distance: Number(r.distance),
    } satisfies JobCandidate;
  });

  // App-side exclusion filter, then the same-signature display collapse, then trim to `limit`. Running the
  // collapse on the over-fetch buffer means a dropped cross-post frees a slot the trim back-fills from the
  // remaining buffer.
  const displayable = candidates.filter((c) => !isExcluded(c, exclusions));
  return collapseBySignature(displayable).slice(0, limit);
}

/**
 * The SQL candidate filter over `jobs j`, before the location rule: has an embedding, active, inside the
 * recency window, not already shown. Shared by retrieval and locations:explain.
 */
export function candidateFilterSql(
  opts: Pick<RetrieveOpts, "recencyDays" | "excludeJobIds" | "excludeSignatures">,
): SQL {
  const recencyDays = opts.recencyDays ?? 14;
  const excludeJobIds = opts.excludeJobIds ?? [];
  const excludeSignatures = opts.excludeSignatures ?? [];
  const conditions = [
    sql`j.embedding IS NOT NULL`,
    sql`j.lifecycle_state = 'active'`,
    // posted_at is nullable — fall back to created_at so a NULL-posted job is not silently dropped.
    // `${n} * interval '1 day'` is the repo idiom (discovery.ts) and handles any numeric recencyDays.
    sql`COALESCE(j.posted_at, j.created_at) >= now() - ${recencyDays} * interval '1 day'`,
  ];
  if (excludeJobIds.length > 0) {
    // One bound text param cast to int[] — avoids the 65535 bind-param ceiling for a large anti-join.
    conditions.push(sql`j.id <> ALL(${intArrayLiteral(excludeJobIds)}::int[])`);
  }
  if (excludeSignatures.length > 0) {
    // Additive repost anti-join: drop a candidate whose content_signature the user has already seen, but
    // KEEP NULL-signature (blank-description) candidates. One bound text param cast to text[] (md5 hex is
    // brace/comma/NUL-free), mirroring the int[] idiom.
    conditions.push(
      sql`(j.content_signature IS NULL OR j.content_signature <> ALL(${textArrayLiteral(excludeSignatures)}::text[]))`,
    );
  }
  return sql.join(conditions, sql` AND `);
}

/**
 * How many location strings are local for this home: they name a city within the radius or the home
 * region. Recorded per digest, so a user whose home has no placed jobs near it shows up as 0.
 */
export async function countLocalStrings(
  db: Db,
  home: NonNullable<LocationFilter["home"]>,
): Promise<number> {
  const result = await db.execute(sql`
    WITH ${homeAndStringFlagsSql(home)}
    SELECT count(*)::int AS n FROM string_flags WHERE near_city OR home_region
  `);
  const row = resultRows(result)[0] as { n?: unknown } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * Same-signature display collapse: from a DISTANCE-SORTED candidate list, keep the first member of each
 * content_signature group and drop later same-signature members, so a cross-posted role occupies ONE
 * digest slot (the closest-to-profile member wins). NULL signatures are each their own group — a
 * blank-description row is never collapsed. Pure + order-preserving; the `Set` is declared OUTSIDE the
 * predicate so state persists across the scan. Generic + exported so the smoke can drive it with minimal
 * `{contentSignature}` objects.
 *
 * CAVEAT (collapse × pre-send probe): the dropped siblings are gone from the candidate set BEFORE the
 * pre-send liveness probe (inngest/probe.ts) runs. So if the kept representative's apply_url is later
 * dead (404/410), the probe drops the WHOLE role with no fallback to a live same-signature sibling — and
 * if it was the digest's only item, no email is sent. Reachable because content_signature excludes the
 * apply_url, so cross-board siblings have DISTINCT urls. Bounded (≤ the retrieved slot count) and usually
 * self-healing next run (the dead member re-surfaces, or a live sibling wins once the dead posting
 * changes); a persistent-404-but-active representative re-loses it until its absence streak closes it.
 * ACCEPTED as low-severity — recover via a probe-time same-signature fallback only if dead-link cross-post
 * recall becomes a real problem.
 */
export function collapseBySignature<T extends { contentSignature: string | null }>(
  candidates: T[],
): T[] {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (c.contentSignature === null) return true;
    if (seen.has(c.contentSignature)) return false;
    seen.add(c.contentSignature);
    return true;
  });
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
  const haystack = `${job.title}\n${job.descriptionText}`;
  return exclusions.some((re) => re.test(haystack));
}
