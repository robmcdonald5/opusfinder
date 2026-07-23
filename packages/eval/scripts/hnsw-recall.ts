/**
 * HNSW-recall measurement (plan §8): how much of the EXACT cosine top-k does the pgvector HNSW
 * index return, on the REAL Neon corpus at its real scale? A MEASUREMENT, not a pass/fail gate —
 * the report is the deliverable (same framing as the prefs YoE directional check).
 *
 * Why it exists: production retrieval currently seq-scans (exact) — neon-http is stateless per
 * request, so `SET LOCAL hnsw.ef_search` can't be honored and the planner ignores the index at
 * today's table size (see repos/retrieval.ts). The moment scale flips the planner to the index,
 * retrieval silently inherits ANN recall at the DEFAULT ef_search=40 — while the digest path
 * over-fetches limit*overFetch=150 rows. This script measures exactly that cliff: recall@{10,50,150}
 * at ef_search {40,100,200}, for the unfiltered nearest-neighbour shape AND the production-filtered
 * shape (active + 14d recency — the filtered-ANN under-fill risk the over-fetch guards).
 *
 * How it stays honest (the #56 vacuity lesson): each leg runs inside a transaction on the
 * TX-CAPABLE neon-serverless driver (`createAuthDb`), planner-forced via SET LOCAL — the exact leg
 * disables index scans, the ANN leg disables seq scans — and each plan is EXPLAIN-verified to have
 * actually taken its path before the query runs. A forced plan that doesn't materialize throws;
 * it never silently scores exact-vs-exact.
 *
 * Read-only by construction: every measurement transaction sets `transaction_read_only = on`
 * first, so a bug can't write to the production DB this script points at.
 *
 * Queries = the committed eval profiles (embedded query-side via the SAME `embed()` production
 * uses) + a deterministic sample of stored job vectors as pseudo-queries (no embed cost, broadens
 * the estimate; document-side vectors, so labeled clearly). Needs DATABASE_URL + VOYAGE_API_KEY.
 *
 *   pnpm eval:hnsw                      # 2 profiles + 8 pseudo-queries -> reports/hnsw-recall.json
 *   pnpm eval:hnsw -- --sample-jobs 0   # profiles only
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isNotNull, sql, type SQL } from "drizzle-orm";

import { createAuthDb, type AuthDb } from "@opusfinder/db/auth-client";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { EMBEDDING_DIMENSIONS, jobs } from "@opusfinder/db/schema";
import { embed } from "@opusfinder/embeddings";
import { composeProfileText, isRecord } from "@opusfinder/shared";
import { runScript } from "@opusfinder/shared/script";

import { annRecallAtK, planUsesIndex, type AnnRecallAtK, type RankedRow } from "../src/ann";
import { getFlag } from "../src/cli";
import { loadDataset } from "../src/dataset";
import { ppDelta } from "../src/report";
import { defaultReportPath, PKG_ROOT, relativeToPkg } from "../src/runner";

/** 150 = production retrieval's default fetch depth (limit 50 × overFetch 3). */
const KS = [10, 50, 150] as const;
/** 40 = the pgvector DEFAULT — the value production would get, since neon-http can't SET it. */
const EF_SEARCH = [40, 100, 200] as const;
const FETCH = Math.max(...KS);
const HNSW_INDEX = "jobs_embedding_hnsw_idx";
const DEFAULT_SAMPLE_JOBS = 8;

/** Local mirror of repos/sql.ts's vectorLiteral/VECTOR_CAST (not on the repos public surface;
 *  6 duplicated lines beat widening the production API for a tooling script). Width-pinned to the
 *  same schema constant, so a dimension swap breaks both in the same commit. */
function vectorLiteral(vec: number[]): string {
  if (vec.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`query vector has ${vec.length} dims; expected ${EMBEDDING_DIMENSIONS}.`);
  }
  return `[${vec.join(",")}]`;
}
const VECTOR_CAST = sql.raw(`::vector(${EMBEDDING_DIMENSIONS})`);

interface Variant {
  name: string;
  /** WHERE body — must mirror the production predicates it claims to represent (retrieval.ts). */
  where: SQL;
}

/** The two shapes production runs: nearestJobs (unfiltered) and the digest retrieval predicates
 *  (has-embedding + active + 14d default recency; the app-side geo/exclusion filters run AFTER the
 *  SQL fetch, so they don't belong in the measured query). */
function buildVariants(): Variant[] {
  return [
    { name: "unfiltered", where: sql`embedding IS NOT NULL` },
    {
      name: "prod-filtered-14d",
      where: sql`embedding IS NOT NULL AND lifecycle_state = 'active' AND COALESCE(posted_at, created_at) >= now() - ${14} * interval '1 day'`,
    },
  ];
}

interface MeasuredQuery {
  label: string;
  vector: number[];
}

/** neon-serverless returns a pg QueryResult (`{ rows }`); mirror repos/sql.ts's resultRows. */
function resultRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (isRecord(result) && Array.isArray(result.rows)) return result.rows;
  throw new Error("unexpected driver result shape.");
}

/** The EXPLAIN (FORMAT JSON) payload: one row, one "QUERY PLAN" column — pre-parsed by the driver
 *  (json oid) or a string, depending on the wire path; accept both. */
function explainPlan(result: unknown): unknown {
  const row = resultRows(result)[0];
  if (!isRecord(row)) throw new Error("EXPLAIN returned no row.");
  const plan = row["QUERY PLAN"];
  return typeof plan === "string" ? JSON.parse(plan) : plan;
}

/**
 * One planner-forced top-FETCH query inside a read-only transaction: SET LOCALs, EXPLAIN-verify the
 * forced path actually materialized, then run it. `mode: "exact"` = seq+sort ground truth;
 * `mode: "ann"` = HNSW at the given ef_search. Throws when the plan disobeys the forcing — a
 * wrong-path run must never be scored.
 */
async function runLeg(
  db: AuthDb,
  where: SQL,
  literal: string,
  mode: "exact" | "ann",
  ef?: number,
): Promise<RankedRow[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL transaction_read_only = on`);
    if (mode === "exact") {
      await tx.execute(sql`SET LOCAL enable_indexscan = off`);
      await tx.execute(sql`SET LOCAL enable_indexonlyscan = off`);
      await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
    } else {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      // sql.raw is safe here: ef comes from the EF_SEARCH const, never from user input.
      await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${ef}`));
    }

    const query = sql`
      SELECT id, embedding <=> ${literal}${VECTOR_CAST} AS distance
      FROM ${jobs}
      WHERE ${where}
      ORDER BY distance
      LIMIT ${FETCH}
    `;

    const plan = explainPlan(await tx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`));
    const usesHnsw = planUsesIndex(plan, HNSW_INDEX);
    if (mode === "ann" && !usesHnsw) {
      throw new Error(
        `ANN leg (ef=${ef}) did not use ${HNSW_INDEX} despite enable_seqscan=off — is the index present/valid?`,
      );
    }
    if (mode === "exact" && usesHnsw) {
      throw new Error(`exact leg used ${HNSW_INDEX} despite enable_indexscan=off — not a ground truth.`);
    }

    return resultRows(await tx.execute(query)).map((row) => {
      const r = row as Record<string, unknown>;
      return { id: Number(r.id), distance: Number(r.distance) };
    });
  });
}

interface CorpusStats {
  totalJobs: number;
  embeddedJobs: number;
  activeEmbedded: number;
  activeEmbedded14d: number;
}

async function corpusStats(db: AuthDb): Promise<CorpusStats> {
  const row = resultRows(
    await db.execute(sql`
      SELECT count(*)::int AS total,
             count(embedding)::int AS embedded,
             (count(embedding) FILTER (WHERE lifecycle_state = 'active'))::int AS active_embedded,
             (count(embedding) FILTER (WHERE lifecycle_state = 'active'
                AND COALESCE(posted_at, created_at) >= now() - ${14} * interval '1 day'))::int AS active_embedded_14d
      FROM ${jobs}
    `),
  )[0] as Record<string, unknown>;
  return {
    totalJobs: Number(row.total),
    embeddedJobs: Number(row.embedded),
    activeEmbedded: Number(row.active_embedded),
    activeEmbedded14d: Number(row.active_embedded_14d),
  };
}

interface QueryResultReport {
  label: string;
  exactRows: number;
  byEf: { ef: number; annRows: number; recalls: AnnRecallAtK[] }[];
}

interface VariantReport {
  name: string;
  queries: QueryResultReport[];
  /** NaN-dropping mean recall per (ef, k); `queries` counts the examples that contributed. */
  means: { ef: number; k: number; recall: number; queries: number }[];
}

/** Persisted shape (reports/hnsw-recall.json). DELIBERATELY no timestamp — corpus stats are the
 *  "when" proxy, and a re-run against an unchanged corpus diffs clean. JSON.stringify writes NaN
 *  as null (JSON has no NaN literal), mirroring the report.ts convention. */
interface HnswRecallReport {
  dataset: string;
  corpus: CorpusStats;
  fetch: number;
  ks: number[];
  efSearch: number[];
  sampleJobIds: number[];
  variants: VariantReport[];
}

const meanOf = (vals: number[]): { mean: number; count: number } => {
  const defined = vals.filter((v) => !Number.isNaN(v));
  if (defined.length === 0) return { mean: NaN, count: 0 };
  return { mean: defined.reduce((a, b) => a + b, 0) / defined.length, count: defined.length };
};

const pct = (x: number): string =>
  Number.isNaN(x) ? "n/a".padStart(6) : `${(x * 100).toFixed(1)}%`.padStart(6);

const numOrNaN = (v: unknown): number => (typeof v === "number" ? v : NaN);

/** Prior committed means keyed by variant/ef/k, for the pp-delta print; {} on any shape problem
 *  (first run, hand-edit) — the diff degrades to "baseline", never crashes the measurement. */
function readPreviousMeans(path: string): Map<string, number> {
  const means = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return means;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.variants)) return means;
  for (const variant of parsed.variants) {
    if (!isRecord(variant) || typeof variant.name !== "string" || !Array.isArray(variant.means)) continue;
    for (const m of variant.means) {
      if (!isRecord(m) || typeof m.ef !== "number" || typeof m.k !== "number") continue;
      means.set(`${variant.name}/${m.ef}/${m.k}`, numOrNaN(m.recall));
    }
  }
  return means;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sampleFlag = getFlag(args, "--sample-jobs");
  const sampleJobs = sampleFlag === undefined ? DEFAULT_SAMPLE_JOBS : Number(sampleFlag);
  // 0 is legitimate (profiles only); negative / non-integer would reach LIMIT verbatim.
  if (!Number.isInteger(sampleJobs) || sampleJobs < 0) {
    throw new Error(`--sample-jobs must be a non-negative integer (got "${sampleFlag}").`);
  }
  const datasetPath = getFlag(args, "--dataset") ?? join(PKG_ROOT, "data", "dataset.jsonl");
  // Dataset-keyed report path (runner.ts convention): a fixture/alternate-dataset run must not
  // clobber the real-dataset baseline — the profiles ARE the measured queries.
  const outPath = getFlag(args, "--out") ?? defaultReportPath("hnsw-recall", null, datasetPath);

  const profiles = loadDataset(datasetPath).map((e) => e.profile);

  const db = createAuthDb(getDatabaseUrl());
  try {
    const corpus = await corpusStats(db);
    console.error(
      `corpus: ${corpus.totalJobs} jobs, ${corpus.embeddedJobs} embedded, ` +
        `${corpus.activeEmbedded} active, ${corpus.activeEmbedded14d} active+14d`,
    );
    if (corpus.embeddedJobs === 0) {
      throw new Error("no embedded jobs — nothing to measure (run embeddings:backfill first?).");
    }

    // Query set: eval profiles embedded query-side via the production embed() (one batch), plus a
    // deterministic first-N-by-id sample of stored job vectors as pseudo-queries (document-side
    // vectors — labeled as such; no embed cost, and stable run-to-run while those ids persist).
    const queries: MeasuredQuery[] = [];
    const texts = profiles.map((p) => composeProfileText(p));
    const { embeddings } = await embed(texts, { inputType: "query" });
    if (embeddings.length !== texts.length) {
      throw new Error(`embed() returned ${embeddings.length} vectors for ${texts.length} profiles.`);
    }
    profiles.forEach((p, i) => queries.push({ label: p.id, vector: embeddings[i] as number[] }));

    const sampled =
      sampleJobs === 0
        ? []
        : await db
            .select({ id: jobs.id, embedding: jobs.embedding })
            .from(jobs)
            .where(isNotNull(jobs.embedding))
            .orderBy(jobs.id)
            .limit(sampleJobs);
    const sampleJobIds: number[] = [];
    for (const s of sampled) {
      if (!s.embedding) continue; // isNotNull filtered these; TS can't see that
      sampleJobIds.push(s.id);
      queries.push({ label: `job-${s.id}`, vector: s.embedding });
    }
    console.error(
      `queries: ${profiles.length} profile(s) + ${sampleJobIds.length} job pseudo-quer${sampleJobIds.length === 1 ? "y" : "ies"}\n`,
    );

    const prevMeans = readPreviousMeans(outPath);
    const variants: VariantReport[] = [];
    for (const variant of buildVariants()) {
      const queryReports: QueryResultReport[] = [];
      for (const q of queries) {
        const literal = vectorLiteral(q.vector);
        const exact = await runLeg(db, variant.where, literal, "exact");
        const byEf: QueryResultReport["byEf"] = [];
        for (const ef of EF_SEARCH) {
          const ann = await runLeg(db, variant.where, literal, "ann", ef);
          byEf.push({
            ef,
            annRows: ann.length,
            recalls: KS.map((k) => annRecallAtK(ann, exact, k)),
          });
        }
        queryReports.push({ label: q.label, exactRows: exact.length, byEf });
      }

      const means: VariantReport["means"] = [];
      for (const ef of EF_SEARCH) {
        for (const k of KS) {
          const agg = meanOf(
            queryReports.map(
              (qr) =>
                qr.byEf.find((e) => e.ef === ef)?.recalls.find((r) => r.k === k)?.recall ?? NaN,
            ),
          );
          means.push({ ef, k, recall: agg.mean, queries: agg.count });
        }
      }
      variants.push({ name: variant.name, queries: queryReports, means });

      // Console table: mean recall per ef/k + mean ANN row count (the under-fill signal), then the
      // pp-delta against the committed baseline when one exists.
      console.error(`variant=${variant.name}  (queries=${queryReports.length}, fetch=${FETCH})`);
      for (const ef of EF_SEARCH) {
        const cells = KS.map(
          (k) => `R@${k} ${pct(means.find((m) => m.ef === ef && m.k === k)?.recall ?? NaN)}`,
        ).join("  ");
        const rowCounts = queryReports.map((qr) => qr.byEf.find((e) => e.ef === ef)?.annRows ?? 0);
        const meanRows = rowCounts.length ? rowCounts.reduce((a, b) => a + b, 0) / rowCounts.length : 0;
        console.error(`  ef=${String(ef).padEnd(3)}  ${cells}   ann rows ${meanRows.toFixed(1)}/${FETCH}`);
        if (prevMeans.size > 0) {
          const deltas = KS.map((k) => {
            const prev = prevMeans.get(`${variant.name}/${ef}/${k}`);
            const next = means.find((m) => m.ef === ef && m.k === k)?.recall ?? NaN;
            return `@${k} ${ppDelta(prev === undefined ? NaN : prev, next, "=")}`;
          }).join("  ");
          console.error(`          vs committed:  ${deltas}`);
        }
      }
      console.error("");
    }
    if (prevMeans.size === 0) {
      console.error("(no previous report — this run establishes the baseline)\n");
    }

    const report: HnswRecallReport = {
      dataset: relativeToPkg(datasetPath),
      corpus,
      fetch: FETCH,
      ks: [...KS],
      efSearch: [...EF_SEARCH],
      sampleJobIds,
      variants,
    };
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.error(`wrote ${relativeToPkg(outPath)}`);
  } finally {
    // The WebSocket Pool keeps its socket open; without this the process hangs at exit.
    await db.$client.end();
  }
}

await runScript("HnswRecall", main);
