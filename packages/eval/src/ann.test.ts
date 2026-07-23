import { describe, expect, it } from "vitest";

import { annRecallAtK, planUsesIndex } from "./ann";

/** Terse row builder: rows(...[id, distance]) — keeps each pinned case one readable line. */
const rows = (...pairs: [number, number][]) => pairs.map(([id, distance]) => ({ id, distance }));

describe("annRecallAtK", () => {
  it("scores identical lists as full recall", () => {
    const exact = rows([1, 0.1], [2, 0.2], [3, 0.3]);
    expect(annRecallAtK(exact, exact, 3)).toEqual({ k: 3, recall: 1, hits: 3, denom: 3 });
  });

  it("scores ANN rows all beyond the exact k-th distance as zero recall", () => {
    const exact = rows([1, 0.1], [2, 0.2], [3, 0.3]);
    const ann = rows([7, 0.5], [8, 0.6], [9, 0.7]);
    expect(annRecallAtK(ann, exact, 3)).toEqual({ k: 3, recall: 0, hits: 0, denom: 3 });
  });

  it("counts a different member of an exact-tie class as a hit (tie-aware, not id-based)", () => {
    // Exact top-3 ends in a 0.2 tie; ANN surfaces id 9 (also 0.2 — an identical cross-post vector)
    // instead of id 3. Id-intersection would call that a miss; distance says it's the same rank.
    const exact = rows([1, 0.1], [2, 0.2], [3, 0.2]);
    const ann = rows([1, 0.1], [2, 0.2], [9, 0.2]);
    expect(annRecallAtK(ann, exact, 3)).toEqual({ k: 3, recall: 1, hits: 3, denom: 3 });
  });

  it("reflects ANN under-fill as lost recall (fewer rows than k, all of them true hits)", () => {
    const exact = rows([1, 0.1], [2, 0.2], [3, 0.3], [4, 0.4], [5, 0.5]);
    const ann = rows([1, 0.1], [2, 0.2]);
    expect(annRecallAtK(ann, exact, 5)).toEqual({ k: 5, recall: 0.4, hits: 2, denom: 5 });
  });

  it("shrinks the denominator when the exact list itself has fewer than k rows", () => {
    const exact = rows([1, 0.1], [2, 0.2], [3, 0.3]);
    const ann = rows([1, 0.1], [2, 0.2], [3, 0.3]);
    expect(annRecallAtK(ann, exact, 10)).toEqual({ k: 10, recall: 1, hits: 3, denom: 3 });
  });

  it("is NaN (undefined) with an empty exact list", () => {
    const result = annRecallAtK(rows([1, 0.1]), [], 5);
    expect(result.recall).toBeNaN();
    expect(result.hits).toBe(0);
    expect(result.denom).toBe(0);
  });

  it("clamps an over-full tie class so recall never exceeds 1", () => {
    // 5 ANN rows all within the 3-row exact list's k-th distance: hits clamp to denom.
    const exact = rows([1, 0.1], [2, 0.1], [3, 0.1]);
    const ann = rows([1, 0.1], [2, 0.1], [3, 0.1], [4, 0.1], [5, 0.1]);
    expect(annRecallAtK(ann, exact, 5)).toEqual({ k: 5, recall: 1, hits: 3, denom: 3 });
  });

  it("ignores ANN rows past position k", () => {
    const exact = rows([1, 0.1], [2, 0.2]);
    const ann = rows([9, 0.9], [8, 0.8], [1, 0.1], [2, 0.2]);
    // Only the first k=2 ANN rows are eligible; the true hits sit past the cutoff.
    expect(annRecallAtK(ann, exact, 2)).toEqual({ k: 2, recall: 0, hits: 0, denom: 2 });
  });
});

describe("planUsesIndex", () => {
  const INDEX = "jobs_embedding_hnsw_idx";

  it("finds the index in a nested EXPLAIN (FORMAT JSON) tree", () => {
    const plan = [
      {
        Plan: {
          "Node Type": "Limit",
          Plans: [{ "Node Type": "Index Scan", "Index Name": INDEX }],
        },
      },
    ];
    expect(planUsesIndex(plan, INDEX)).toBe(true);
  });

  it("is false for a seq-scan plan", () => {
    const plan = [
      {
        Plan: {
          "Node Type": "Limit",
          Plans: [{ "Node Type": "Sort", Plans: [{ "Node Type": "Seq Scan" }] }],
        },
      },
    ];
    expect(planUsesIndex(plan, INDEX)).toBe(false);
  });

  it("is false for a different index and for non-plan values", () => {
    const plan = [{ Plan: { "Node Type": "Index Scan", "Index Name": "jobs_embedding_null_idx" } }];
    expect(planUsesIndex(plan, INDEX)).toBe(false);
    expect(planUsesIndex(null, INDEX)).toBe(false);
    expect(planUsesIndex("Index Name", INDEX)).toBe(false);
  });
});
