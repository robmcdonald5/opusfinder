/**
 * Build the pooled candidate snapshot for each per-profile label file: the union of three
 * nomination arms over the live corpus, written to data/pools/<id>.json (gitignored; only the
 * frozen dataset.jsonl the pools feed is committed).
 *
 * Why pooled: at the ~100k-job corpus a full-board candidate pool is unlabelable, so each
 * example is labeled against the union of what several retrievers surface. Labels are honest
 * only WITHIN that pool — unlabeled ≠ irrelevant; never compute full-corpus labeled recall
 * from pool-scoped labels.
 *
 * Why three arms: a Voyage-only pool would make the labels circular (the ranker under test
 * nominates its own ground truth, so competitors get penalized for finding good jobs the pool
 * never showed the labeler). The arms:
 *   - voyage: the digest read path's SEMANTIC (active + 14d recency, cosine-nearest, signature
 *     collapse — retrieval.ts's predicates + post-processing) over a query-side embedding of
 *     composeProfileText, but run as a PLANNER-FORCED EXACT scan (the hnsw-recall exact-leg
 *     pattern: tx-capable driver + SET LOCAL + EXPLAIN-verified). NOT
 *     retrieveCandidatesForProfile itself: the planner now picks the HNSW index for this shape
 *     at the default ef_search=40, where the filtered fetch under-fills to single digits (the
 *     measured cliff — reports/hnsw-recall.dataset.json). The pool must nominate at full
 *     retrieval recall; the production under-fill is a retrieval incident to fix there, not a
 *     ground truth to inherit here. Geo/exclusion prefs deliberately neutral: the pool
 *     nominates broadly; the eval ranker doesn't filter either.
 *   - fts: Postgres full-text search over title+description with the profile's target roles and
 *     skills OR-ed — surfaces keyword-obvious jobs the embedding may rank low.
 *   - random: a seeded (profile-id-keyed, mulberry32) sample of the same filtered corpus — an
 *     unbiased floor so labels aren't confined to what any retriever thinks is good.
 * All arms share the same base predicates (embedded + active + 14d recency — the
 * "prod-filtered" shape hnsw-recall measures), so the pool is a coherent "what prod could
 * surface today" set. The pool is signature-collapsed ACROSS arms: a cross-posted role carries
 * identical text (identical embedding), so pooling two copies would force duplicate labels and
 * seed exact-distance tie noise — one member represents the group, the same rule production
 * applies at display time (collapseBySignature).
 *
 * Regeneration against a changed corpus is a deliberate refresh: pool ids shift, and
 * build:dataset fails loud on any goodId absent from the new pool (forcing relabeling) instead
 * of silently rescoring stale labels.
 *
 *   pnpm --filter @opusfinder/eval build:pool                       # all data/profiles/*.json
 *   pnpm --filter @opusfinder/eval build:pool -- --profile it-sysadmin
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { inArray, sql } from "drizzle-orm";

import { createAuthDb, type AuthDb } from "@opusfinder/db/auth-client";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { EMBEDDING_DIMENSIONS, jobs } from "@opusfinder/db/schema";
import { embed } from "@opusfinder/embeddings";
import { composeProfileText, isRecord } from "@opusfinder/shared";
import { runScript } from "@opusfinder/shared/script";

import { planUsesIndex } from "../src/ann";
import { getFlag } from "../src/cli";
import { hashString, mulberry32 } from "../src/rng";
import { relativeToPkg } from "../src/runner";
import type { EvalProfile } from "../src/types";
import {
  loadAllProfileFiles,
  loadProfileFile,
  poolPath,
  POOLS_DIR,
  PROFILES_DIR,
  type PoolCandidate,
  type PoolFile,
} from "./pooling";

const VOYAGE_K = 40;
const FTS_K = 20;
const RANDOM_K = 15;
const RECENCY_DAYS = 14;
/** SQL over-fetch multiplier for the fts arm, so cross-arm dedupe + the signature collapse can't
 *  under-fill its quota (same guard prod retrieval uses). */
const ARM_OVERFETCH = 3;
/** Voyage-arm fetch depth before the signature collapse trims to VOYAGE_K distinct roles. */
const VOYAGE_FETCH = VOYAGE_K * 4;
const HNSW_INDEX = "jobs_embedding_hnsw_idx";

/** Local mirror of repos/sql.ts's vectorLiteral/VECTOR_CAST (the hnsw-recall precedent — a few
 *  duplicated lines beat widening the production API for a tooling script). */
function vectorLiteral(vec: number[]): string {
  if (vec.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`query vector has ${vec.length} dims; expected ${EMBEDDING_DIMENSIONS}.`);
  }
  return `[${vec.join(",")}]`;
}
const VECTOR_CAST = sql.raw(`::vector(${EMBEDDING_DIMENSIONS})`);

/** The shared base predicates — must mirror retrieval.ts's SQL conditions (hnsw-recall pins the
 *  same shape as its "prod-filtered-14d" variant). */
const BASE_WHERE = sql`embedding IS NOT NULL AND lifecycle_state = 'active' AND COALESCE(posted_at, created_at) >= now() - ${RECENCY_DAYS} * interval '1 day'`;

/** Local mirror of repos/sql.ts's resultRows (not on the repos public surface; the hnsw-recall
 *  precedent — a few duplicated lines beat widening the production API for a tooling script). */
function resultRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (isRecord(result) && Array.isArray(result.rows)) return result.rows;
  throw new Error("unexpected driver result shape.");
}

/** jobs.locations is jsonb<string[]>; neon-http returns it pre-parsed. */
function parseLocations(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

interface ArmRow {
  id: number;
  title: string;
  descriptionText: string;
  locations: string[];
  remote: boolean;
  contentSignature: string | null;
}

function armRow(row: unknown): ArmRow {
  const r = row as Record<string, unknown>;
  return {
    id: Number(r.id),
    title: typeof r.title === "string" ? r.title : String(r.title),
    // RAW text, never trimmed — the harness's "embed what ships" invariant (see build-dataset).
    descriptionText:
      typeof r.description_text === "string" ? r.description_text : String(r.description_text ?? ""),
    locations: parseLocations(r.locations),
    remote: r.remote === true,
    contentSignature: typeof r.content_signature === "string" ? r.content_signature : null,
  };
}

/** websearch_to_tsquery input: target roles + skills as OR-ed quoted phrases. websearch parsing
 *  never throws on user text; embedded quotes are flattened to spaces so a term can't break out
 *  of its phrase. */
function ftsQueryText(profile: EvalProfile): string {
  return [...profile.targetRoles, ...profile.skills]
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, " ")}"`)
    .join(" OR ");
}

/** Accumulates the pool with cross-arm id dedupe + signature collapse. */
class Pool {
  readonly members: PoolCandidate[] = [];
  private readonly byId = new Map<number, PoolCandidate>();
  private readonly seenSignatures = new Set<string>();
  droppedCrossPosts = 0;

  /** Add a candidate under `arm`; returns true when it consumed a NEW pool slot. An id already
   *  pooled just gains the arm tag (provenance); a same-signature cross-post is dropped. */
  add(row: ArmRow, arm: PoolCandidate["arms"][number], extra?: Partial<PoolCandidate>): boolean {
    const existing = this.byId.get(row.id);
    if (existing) {
      if (!existing.arms.includes(arm)) existing.arms.push(arm);
      Object.assign(existing, extra);
      return false;
    }
    if (row.contentSignature !== null && this.seenSignatures.has(row.contentSignature)) {
      this.droppedCrossPosts++;
      return false;
    }
    const member: PoolCandidate = { ...row, arms: [arm], ...extra };
    this.members.push(member);
    this.byId.set(row.id, member);
    if (row.contentSignature !== null) this.seenSignatures.add(row.contentSignature);
    return true;
  }
}

/** The EXPLAIN (FORMAT JSON) payload: one row, one "QUERY PLAN" column — pre-parsed by the
 *  driver or a string depending on the wire path; accept both (hnsw-recall's helper). */
function explainPlan(result: unknown): unknown {
  const row = resultRows(result)[0];
  if (!isRecord(row)) throw new Error("EXPLAIN returned no row.");
  const plan = row["QUERY PLAN"];
  return typeof plan === "string" ? JSON.parse(plan) : plan;
}

/** The exact cosine-nearest fetch for the voyage arm: a read-only, planner-forced (no index
 *  scans), EXPLAIN-verified transaction — it must never silently inherit the HNSW under-fill it
 *  exists to avoid. */
async function exactNearest(
  db: AuthDb,
  literal: string,
): Promise<(ArmRow & { distance: number })[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL transaction_read_only = on`);
    await tx.execute(sql`SET LOCAL enable_indexscan = off`);
    await tx.execute(sql`SET LOCAL enable_indexonlyscan = off`);
    await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
    const query = sql`
      SELECT id, title, description_text, locations, remote, content_signature,
             embedding <=> ${literal}${VECTOR_CAST} AS distance
      FROM ${jobs}
      WHERE ${BASE_WHERE}
      ORDER BY distance
      LIMIT ${VOYAGE_FETCH}
    `;
    const plan = explainPlan(await tx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`));
    if (planUsesIndex(plan, HNSW_INDEX)) {
      throw new Error(`voyage arm used ${HNSW_INDEX} despite enable_indexscan=off — not exact.`);
    }
    return resultRows(await tx.execute(query)).map((row) => ({
      ...armRow(row),
      distance: Number((row as Record<string, unknown>).distance),
    }));
  });
}

async function buildPoolFor(db: AuthDb, profile: EvalProfile): Promise<PoolFile> {
  const pool = new Pool();

  // Arm 1 — voyage: query-side embedding (profiles/embed.ts's exact shape), exact nearest, then
  // retrieval.ts's post-processing semantic: distance||id tiebreak sort, signature collapse
  // (Pool.add — nearest member represents the group), trim to VOYAGE_K.
  const { embeddings } = await embed([composeProfileText(profile)], { inputType: "query" });
  const queryVec = embeddings[0];
  if (!queryVec) throw new Error(`embed() returned no vector for profile ${profile.id}.`);
  const nearest = await exactNearest(db, vectorLiteral(queryVec));
  nearest.sort((a, b) => a.distance - b.distance || a.id - b.id);
  let voyageCount = 0;
  for (const c of nearest) {
    if (voyageCount >= VOYAGE_K) break;
    const { distance, ...row } = c;
    if (pool.add(row, "voyage", { voyageRank: voyageCount + 1, voyageDistance: distance })) {
      voyageCount++;
    }
  }

  // Arm 2 — fts. ts_rank DESC with an id tiebreak so the arm is deterministic on rank ties.
  const queryText = ftsQueryText(profile);
  const tsv = sql`to_tsvector('english', title || ' ' || description_text)`;
  const tsq = sql`websearch_to_tsquery('english', ${queryText})`;
  const ftsRows = resultRows(
    await db.execute(sql`
      SELECT id, title, description_text, locations, remote, content_signature,
             ts_rank(${tsv}, ${tsq}) AS rank
      FROM ${jobs}
      WHERE ${BASE_WHERE} AND ${tsv} @@ ${tsq}
      ORDER BY rank DESC, id
      LIMIT ${FTS_K * ARM_OVERFETCH}
    `),
  ).map((row, i) => ({ row: armRow(row), rank: i + 1 }));
  let ftsAccepted = 0;
  for (const { row, rank } of ftsRows) {
    if (ftsAccepted >= FTS_K) break;
    if (pool.add(row, "fts", { ftsRank: rank })) ftsAccepted++;
  }

  // Arm 3 — random: seeded shuffle of the eligible ids (client-side — SQL random() can't be
  // seeded per-profile), then fetch the accepted rows. Deterministic for a fixed corpus + profile
  // id; a corpus change reshuffles, which a pool rebuild is anyway.
  const eligible = resultRows(
    await db.execute(sql`SELECT id, content_signature FROM ${jobs} WHERE ${BASE_WHERE} ORDER BY id`),
  ).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: Number(r.id),
      contentSignature: typeof r.content_signature === "string" ? r.content_signature : null,
    };
  });
  const rng = mulberry32(hashString(profile.id));
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j] as (typeof eligible)[number], eligible[i] as (typeof eligible)[number]];
  }
  const randomIds: number[] = [];
  const pooledIds = new Set(pool.members.map((m) => m.id));
  const pooledSigs = new Set(
    pool.members.map((m) => m.contentSignature).filter((s): s is string => s !== null),
  );
  for (const e of eligible) {
    if (randomIds.length >= RANDOM_K) break;
    if (pooledIds.has(e.id)) continue;
    if (e.contentSignature !== null && pooledSigs.has(e.contentSignature)) continue;
    randomIds.push(e.id);
    if (e.contentSignature !== null) pooledSigs.add(e.contentSignature);
  }
  if (randomIds.length > 0) {
    const rows = await db
      .select({
        id: jobs.id,
        title: jobs.title,
        descriptionText: jobs.descriptionText,
        locations: jobs.locations,
        remote: jobs.remote,
        contentSignature: jobs.contentSignature,
      })
      .from(jobs)
      .where(inArray(jobs.id, randomIds));
    // Restore the seeded draw order (IN gives no order guarantee).
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of randomIds) {
      const r = byId.get(id);
      if (!r) throw new Error(`random-arm job ${id} vanished between select and fetch.`);
      pool.add(
        {
          id: r.id,
          title: r.title,
          descriptionText: r.descriptionText,
          locations: parseLocations(r.locations),
          remote: r.remote,
          contentSignature: r.contentSignature,
        },
        "random",
      );
    }
  }

  // No silent caps: an under-filled arm (a cross-post-dominated neighborhood deeper than the
  // fetch, or a narrow FTS match set) must be visible in the run log, not read as "covered".
  if (voyageCount < VOYAGE_K) {
    console.error(`  WARNING: voyage arm filled ${voyageCount}/${VOYAGE_K} (fetch ${VOYAGE_FETCH}).`);
  }
  if (ftsAccepted < FTS_K) {
    console.error(`  note: fts arm filled ${ftsAccepted}/${FTS_K} (narrow match set is expected for some profiles).`);
  }
  console.error(
    `[${profile.id}] pool=${pool.members.length} (voyage ${voyageCount}, +fts ${ftsAccepted}, ` +
      `+random ${randomIds.length}; ${pool.droppedCrossPosts} cross-post(s) collapsed) ` +
      `of ${eligible.length} eligible`,
  );

  return {
    profileId: profile.id,
    arms: { voyageK: VOYAGE_K, ftsK: FTS_K, randomK: RANDOM_K, recencyDays: RECENCY_DAYS },
    corpus: { eligibleJobs: eligible.length },
    candidates: pool.members,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = getFlag(args, "--profile");
  const labeled = only
    ? [loadProfileFile(`${PROFILES_DIR}/${only}.json`)]
    : loadAllProfileFiles();
  if (labeled.length === 0) {
    throw new Error(`no profile files in ${relativeToPkg(PROFILES_DIR)} — nothing to pool.`);
  }

  const db = createAuthDb(getDatabaseUrl());
  try {
    mkdirSync(POOLS_DIR, { recursive: true });
    for (const { profile } of labeled) {
      const pool = await buildPoolFor(db, profile);
      const out = poolPath(profile.id);
      writeFileSync(out, `${JSON.stringify(pool, null, 2)}\n`, "utf8");
      console.error(`  wrote ${relativeToPkg(out)}`);
    }
  } finally {
    // The WebSocket Pool keeps its socket open; without this the process hangs at exit.
    await db.$client.end();
  }
}

await runScript("BuildPool", main);
