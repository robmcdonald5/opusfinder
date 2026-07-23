/**
 * ANN-vs-exact recall math for the HNSW measurement (scripts/hnsw-recall.ts). Pure and pinned by
 * ann.test.ts — same discipline as metrics/cosine: the script stays orchestration-only, and the
 * math that decides the reported number lives here under unit tests.
 *
 * Recall is TIE-AWARE, judged on DISTANCE rather than id-intersection: same-signature cross-posts
 * carry IDENTICAL embeddings (the F1 dedupe reality), so the exact top-k's tail is frequently a tie
 * class whose member ORDER is implementation-defined. An ANN row counts as a hit iff its distance
 * is <= the exact k-th distance (+ a float-noise epsilon) — i.e. it belongs to the tied true-top-k
 * set — so the metric can't punish the index for returning a different-but-equally-near tie member.
 */

export interface RankedRow {
  id: number;
  /** Cosine distance (`<=>`) from the query vector; smaller is closer. */
  distance: number;
}

export interface AnnRecallAtK {
  k: number;
  /** hits / denom. NaN when the exact list is empty (recall undefined). */
  recall: number;
  hits: number;
  /** min(k, exact.length) — when a selective filter leaves fewer than k true rows, the shortfall
   *  must not read as ANN misses. */
  denom: number;
}

/** Absorbs float formatting noise between the two plans' projections of the same `<=>` expression.
 *  Both legs compute the identical expression server-side, so equality is expected bit-for-bit;
 *  the epsilon only guards against a plan-dependent evaluation-order difference. */
const DISTANCE_EPSILON = 1e-9;

/**
 * Recall@k of an ANN result against the exact ground-truth ranking (both best-first). An ANN row in
 * the top k is a hit iff its distance is within the exact k-th distance (tie-aware, see module doc).
 * Hits are clamped to `denom` so an over-full tie class can't push recall past 1 — unreachable when
 * both legs query the same filtered set (ann ⊆ exact's row universe), but the pure function should
 * not rely on that.
 */
export function annRecallAtK(ann: RankedRow[], exact: RankedRow[], k: number): AnnRecallAtK {
  const denom = Math.min(k, exact.length);
  if (denom === 0) return { k, recall: NaN, hits: 0, denom: 0 };
  const kth = (exact[denom - 1] as RankedRow).distance;
  let hits = 0;
  for (const row of ann.slice(0, k)) {
    if (row.distance <= kth + DISTANCE_EPSILON) hits += 1;
  }
  hits = Math.min(hits, denom);
  return { k, recall: hits / denom, hits, denom };
}

/**
 * Whether an EXPLAIN (FORMAT JSON) tree contains an index node over `indexName`. The measurement
 * EXPLAINs each forced plan before running it: the ANN leg must show the HNSW index and the exact
 * leg must NOT — otherwise the "recall" silently compares a path against itself and reports a
 * vacuous 100% (the #56 vacuity lesson, applied). Walks only the plan-shaped keys (`Plan`/`Plans`)
 * plus top-level arrays, so an unrelated string field can't false-match.
 */
export function planUsesIndex(node: unknown, indexName: string): boolean {
  if (Array.isArray(node)) return node.some((n) => planUsesIndex(n, indexName));
  if (typeof node !== "object" || node === null) return false;
  const rec = node as Record<string, unknown>;
  if (rec["Index Name"] === indexName) return true;
  return planUsesIndex(rec["Plan"], indexName) || planUsesIndex(rec["Plans"], indexName);
}
