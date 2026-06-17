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

import type { LocationMode } from "@opusfinder/shared";

import type { Db } from "../client";
import { jobs } from "../schema";
import { intArrayLiteral, resultRows, textArrayLiteral, VECTOR_CAST, vectorLiteral } from "./sql";

export interface RetrieveOpts {
  /** Final candidate count returned (default 50). */
  limit?: number;
  /** SQL fetch multiplier before the app-side post-filters (geo + exclusions) trim to `limit`
   *  (default 3). Guards against those filters — and pgvector's filtered-ANN post-filtering —
   *  under-filling the result. */
  overFetch?: number;
  /** From user_preferences: Indeed/LinkedIn-style location mode (default "any"). `remote_only` keeps only
   *  remote jobs; `onsite_only` keeps only on-site jobs (subject to `locations`); `any` keeps both. Applied
   *  app-side in geoMatches. SUBSUMES the former `remoteOk` boolean. */
  locationMode?: LocationMode;
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
  /** Already-shown content signatures to exclude — the F1 repost anti-join (alreadyShownSignatures feeds
   *  this). A re-listed role gets a fresh external_id → a new job_id the id anti-join can't see, but the
   *  SAME content_signature; this suppresses it. A NULL-signature candidate is never excluded by it. */
  excludeSignatures?: string[];
}

export interface JobCandidate {
  id: number;
  title: string;
  descriptionText: string;
  locations: string[];
  remote: boolean;
  /** The F1 content-dedup signature (md5 of normalized title+desc), or NULL until backfilled. Drives the
   *  same-signature display collapse. NOT forwarded into Inngest step state — the retrieve step
   *  deliberately returns only id/title/description (decision 4); this stays a local retrieval field. */
  contentSignature: string | null;
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
  const locationMode = opts.locationMode ?? "any";
  const locations = opts.locations ?? [];
  const recencyDays = opts.recencyDays ?? 14;
  const exclusions = compileExclusions(opts.exclusions ?? []);
  const excludeJobIds = opts.excludeJobIds ?? [];
  const excludeSignatures = opts.excludeSignatures ?? [];
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
  if (excludeSignatures.length > 0) {
    // Additive repost anti-join (F1c): drop a candidate whose content_signature the user has already
    // seen, but KEEP NULL-signature (un-backfilled) candidates — they behave exactly as pre-F1. One
    // bound text param cast to text[] (md5 hex is brace/comma/NUL-free), mirroring the int[] idiom.
    const sigLiteral = textArrayLiteral(excludeSignatures);
    conditions.push(sql`(content_signature IS NULL OR content_signature <> ALL(${sigLiteral}::text[]))`);
  }
  const whereClause = sql.join(conditions, sql` AND `);

  // Bind the query vector once (the distance alias keeps the HNSW sort pathkey — see nearestJobs).
  const result: unknown = await db.execute(sql`
    SELECT id, title, description_text, locations, remote, content_signature,
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
      contentSignature: typeof r.content_signature === "string" ? r.content_signature : null,
      distance: Number(r.distance),
    } satisfies JobCandidate;
  });

  // Deterministic tiebreak: same-signature cross-posts have IDENTICAL embeddings → an exact distance tie
  // that the SQL `ORDER BY distance` (kept single-key on purpose, to preserve the HNSW sort pathkey) leaves
  // in implementation-defined order. Re-break ties by id here so collapseBySignature's "first member wins"
  // keeps a STABLE representative run-to-run (the lowest/oldest job id) instead of a flipping
  // apply_url/company. No-op for distinct distances (distance still decides), so the HNSW ordering stands.
  candidates.sort((a, b) => a.distance - b.distance || a.id - b.id);

  // App-side geo + exclusion filters, then the same-signature display collapse (F1b), then trim to
  // `limit` (see the file header for why app-side). Running the collapse on the over-fetch buffer means
  // a dropped cross-post frees a slot the trim back-fills from the remaining buffer.
  const displayable = candidates.filter(
    (c) => geoMatches(c, locationMode, locations) && !isExcluded(c, exclusions),
  );
  return collapseBySignature(displayable).slice(0, limit);
}

/**
 * Same-signature display collapse (F1b): from a DISTANCE-SORTED candidate list, keep the first member of
 * each content_signature group and drop later same-signature members, so a cross-posted role occupies
 * ONE digest slot (the closest-to-profile member wins). NULL signatures are each their own group — an
 * un-backfilled row is never collapsed. Pure + order-preserving; the `Set` is declared OUTSIDE the
 * predicate so state persists across the scan. Generic + exported so the smoke can drive it with minimal
 * `{contentSignature}` objects.
 *
 * CAVEAT (F1b × F2 Arm C — F1–F8 review B1): the dropped siblings are gone from the candidate set BEFORE
 * the pre-send liveness probe (inngest/probe.ts) runs. So if the kept representative's apply_url is later
 * dead (404/410), the probe drops the WHOLE role with no fallback to a live same-signature sibling — and
 * if it was the digest's only item, no email is sent. Reachable because content_signature excludes the
 * apply_url, so cross-board siblings have DISTINCT urls. Bounded (≤ the retrieved slot count) and usually
 * self-healing next run (the dead member re-surfaces, or a live sibling wins once the dead posting
 * changes); a persistent-404-but-active representative re-loses it until Arm A's absence streak closes it.
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
  const hay = `${job.title}\n${job.descriptionText}`;
  return exclusions.some((re) => re.test(hay));
}

/**
 * Indeed/LinkedIn-style geo match (Phase F3), branching on the user's {@link LocationMode}:
 * - a REMOTE job passes unless the mode is `onsite_only` (so `any`/`remote_only` keep it);
 * - an ON-SITE job is dropped under `remote_only`; otherwise (`any`/`onsite_only`) it passes iff the user
 *   set no location constraint, OR the job has no location data (unknown ≠ mismatch — ATS feeds often
 *   leave locations empty, putting it in the description; dropping these would silently tank recall, so
 *   include and let rerank/synthesis judge), OR one of the user's locations overlaps a job location.
 * SUBSUMES the former boolean: `remote_ok=true`→`any`, `false`→`onsite_only`. The exact on-site rule still
 * firms up with the Phase-12 onboarding form. `onsite_only` is the only mode that drops jobs the prior
 * filter kept (all remote) — it inherits the unknown-location-passes rule above. Generic + exported so the
 * smoke can drive the truth table with minimal `{remote, locations}` objects.
 */
export function geoMatches<T extends { remote: boolean; locations: string[] }>(
  job: T,
  mode: LocationMode,
  locations: string[],
): boolean {
  if (job.remote) return mode !== "onsite_only";
  if (mode === "remote_only") return false; // on-site job, remote-only user
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
