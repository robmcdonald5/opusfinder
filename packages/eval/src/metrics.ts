/**
 * Ranking-quality metrics. Pure, dependency-free, and the single source of truth every ranker
 * is judged by. Relevance is BINARY: an id is relevant iff it is in the example's
 * `expectedGoodIds`. `metrics.test.ts` pins this math against hand-computed cases, so a
 * refactor that breaks it fails loudly.
 */

/** Default ranking cutoffs reported by the harness. Small pools (~20-40 candidates). */
export const DEFAULT_KS = [3, 5, 10] as const;

export interface MetricsAtK {
  k: number;
  /** |relevant ∩ top-k| / min(k, ranked.length). */
  precision: number;
  /** |relevant ∩ top-k| / |relevant|. NaN when there are no relevant ids (recall undefined). */
  recall: number;
  /** DCG@k / IDCG@k with binary gains. NaN when there are no relevant ids. */
  ndcg: number;
}

const log2 = (x: number): number => Math.log(x) / Math.LN2;

/**
 * Score one ranking against the relevant set at cutoff k. `ranked` is best-first ids, `good`
 * the relevant id set. Precision divides by min(k, ranked.length) so a candidate pool smaller
 * than k isn't unfairly penalized. Recall and NDCG are NaN when `good` is empty (their ratios
 * are undefined) — the aggregator DROPS NaNs rather than treating them as 0, which would
 * silently deflate the means. `good` is de-duplicated via a Set so an accidental repeat can't
 * push recall above 1.
 */
export function scoreRanking(ranked: number[], good: number[], k: number): MetricsAtK {
  const goodSet = new Set(good);
  const topK = ranked.slice(0, k);
  const denom = Math.min(k, ranked.length);

  let hits = 0;
  let dcg = 0;
  topK.forEach((id, i) => {
    if (goodSet.has(id)) {
      hits += 1;
      // 0-based position i → rank (i+1) → gain / log2(rank + 1) = 1 / log2(i + 2).
      dcg += 1 / log2(i + 2);
    }
  });

  // Ideal DCG: the min(k, |relevant|) relevant items packed into the top positions.
  const idealHits = Math.min(k, goodSet.size);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / log2(i + 2);

  return {
    k,
    precision: denom === 0 ? 0 : hits / denom,
    recall: goodSet.size === 0 ? NaN : hits / goodSet.size,
    ndcg: idcg === 0 ? NaN : dcg / idcg,
  };
}

export interface AggregateMetrics {
  k: number;
  precision: number;
  recall: number;
  ndcg: number;
  /** How many examples contributed to each mean (NaN values are excluded per-metric). */
  counts: { precision: number; recall: number; ndcg: number };
}

/**
 * Mean of each metric across per-example scores at one k, ignoring NaN (undefined) values.
 * A metric whose every example was NaN aggregates to NaN with count 0 — surfaced, not hidden.
 */
export function aggregateAtK(perExample: MetricsAtK[], k: number): AggregateMetrics {
  const at = perExample.filter((m) => m.k === k);
  const meanOf = (vals: number[]): { mean: number; count: number } => {
    const defined = vals.filter((v) => !Number.isNaN(v));
    if (defined.length === 0) return { mean: NaN, count: 0 };
    return { mean: defined.reduce((a, b) => a + b, 0) / defined.length, count: defined.length };
  };
  const precisionAgg = meanOf(at.map((m) => m.precision));
  const recallAgg = meanOf(at.map((m) => m.recall));
  const ndcgAgg = meanOf(at.map((m) => m.ndcg));
  return {
    k,
    precision: precisionAgg.mean,
    recall: recallAgg.mean,
    ndcg: ndcgAgg.mean,
    counts: { precision: precisionAgg.count, recall: recallAgg.count, ndcg: ndcgAgg.count },
  };
}
