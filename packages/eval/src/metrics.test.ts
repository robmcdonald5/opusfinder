import { describe, expect, it } from "vitest";

import { aggregateAtK, scoreRanking } from "./metrics";

// Leaf pure-unit. This math is the single source of truth every ranker is judged by, so the
// load-bearing edges are the divisor choices: precision divides by min(k, pool) (a short pool
// isn't penalized), recall/ndcg are NaN — not 0 — when there are no relevant ids, and the
// aggregator DROPS those NaNs from its means rather than deflating them. Ports the hand-computed
// cases from scripts/test-metrics.ts. Frozen integer fixtures, exact closeness via toBeCloseTo.

// log2(3) = 1.584962500721156; ideal DCG@3 over 3 relevant = 1 + 1/log2(3) + 1/2 ≈ 2.1309297535714573.
const IDCG3 = 1 + 1 / (Math.log(3) / Math.LN2) + 0.5;

describe("scoreRanking", () => {
  it("perfect ranking → precision/recall/ndcg all 1", () => {
    const m = scoreRanking([1, 2, 3, 4, 5], [1, 2, 3], 3);
    expect(m.precision).toBeCloseTo(1, 9);
    expect(m.recall).toBeCloseTo(1, 9);
    expect(m.ndcg).toBeCloseTo(1, 9);
  });

  it("relevant items pushed below the cutoff → one hit at rank 3", () => {
    const m = scoreRanking([4, 5, 1, 2, 3], [1, 2, 3], 3);
    expect(m.precision).toBeCloseTo(1 / 3, 9);
    expect(m.recall).toBeCloseTo(1 / 3, 9);
    // one hit at rank 3 → gain 1/log2(4) = 0.5, over the 3-relevant IDCG.
    expect(m.ndcg).toBeCloseTo(0.5 / IDCG3, 9);
  });

  it("no relevant ids → precision 0, recall/ndcg undefined (NaN)", () => {
    const m = scoreRanking([1, 2, 3], [], 3);
    expect(m.precision).toBe(0);
    expect(m.recall).toBeNaN();
    expect(m.ndcg).toBeNaN();
  });

  it("fewer candidates than k → precision divides by pool size, not k", () => {
    const m = scoreRanking([1], [1], 3);
    expect(m.precision).toBeCloseTo(1, 9); // 1 hit / min(3,1) = 1, not 1/3
    expect(m.recall).toBeCloseTo(1, 9);
    expect(m.ndcg).toBeCloseTo(1, 9);
  });

  it("more relevant items than k → recall divides by |good|, IDCG caps at k", () => {
    const m = scoreRanking([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], 3);
    expect(m.precision).toBeCloseTo(1, 9); // top-3 all relevant
    expect(m.recall).toBeCloseTo(3 / 5, 9); // only 3 of 5 relevant fit in k=3
    // IDCG spans min(k, |good|) = 3 ideal positions, so a perfect top-3 scores exactly 1.
    expect(m.ndcg).toBeCloseTo(1, 9);
  });

  it("empty ranking → precision guarded to 0 (no 0/0 NaN), recall/ndcg 0", () => {
    const m = scoreRanking([], [1, 2, 3], 3);
    expect(m.precision).toBe(0); // denom min(3,0)=0 → guarded to 0, not NaN
    expect(m.recall).toBe(0); // 0 hits / 3 relevant
    expect(m.ndcg).toBe(0); // dcg 0 / nonzero idcg
  });

  it("duplicate relevant ids are de-duped via a Set so recall can't exceed 1", () => {
    const m = scoreRanking([1, 2, 3], [1, 1, 1], 3);
    expect(m.recall).toBeCloseTo(1, 9); // one hit / |Set{1}| = 1
  });
});

describe("aggregateAtK", () => {
  it("drops NaN metrics from the mean and reports the contributing count", () => {
    const ex1 = scoreRanking([1, 2, 3], [1], 3); // precision 1/3, recall 1, ndcg 1
    const ex2 = scoreRanking([1, 2, 3], [], 3); // precision 0, recall NaN, ndcg NaN
    const agg = aggregateAtK([ex1, ex2], 3);

    expect(agg.precision).toBeCloseTo((1 / 3 + 0) / 2, 9); // both examples count
    expect(agg.recall).toBeCloseTo(1, 9); // only ex1 has a defined recall
    expect(agg.ndcg).toBeCloseTo(1, 9);
    expect(agg.counts).toEqual({ precision: 2, recall: 1, ndcg: 1 });
  });

  it("a metric NaN in every example aggregates to NaN with count 0 (surfaced, not hidden)", () => {
    const ex = scoreRanking([1, 2, 3], [], 3); // recall + ndcg NaN
    const agg = aggregateAtK([ex], 3);
    expect(agg.recall).toBeNaN();
    expect(agg.ndcg).toBeNaN();
    expect(agg.counts.recall).toBe(0);
  });

  it("only scores at the requested k contribute", () => {
    const at3 = scoreRanking([1, 2, 3], [1], 3);
    const at5 = scoreRanking([1, 2, 3, 4, 5], [9], 5); // would drag means down if counted
    const agg = aggregateAtK([at3, at5], 3);
    expect(agg.counts.precision).toBe(1); // only the k=3 score
    expect(agg.precision).toBeCloseTo(1 / 3, 9);
  });
});
