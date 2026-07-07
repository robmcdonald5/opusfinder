import { describe, expect, it } from "vitest";

import { scoreRanker } from "./runner";
import type { EvalExample, EvalJob, EvalProfile, Ranker } from "./types";

// Leaf pure-unit. `scoreRanker` is the orchestration every ranker is judged through, so two things are
// load-bearing and locked here: (1) the permutation guard (`assertPermutation`, reachable only via
// scoreRanker) — a ranker that drops or fabricates ids must FAIL, not silently inflate its score by
// shedding hard candidates; (2) the per-(example,k) metric math at DEFAULT_KS = [3,5,10] against a
// frozen ranking, including the NaN-recall/NaN-ndcg case when an example has no relevant ids. Numbers
// are hand-computed and pinned.

const profile: EvalProfile = {
  id: "backend-ic-1",
  summary: "Senior backend engineer",
  skills: ["Go"],
  targetRoles: ["Backend Engineer"],
};

const candidateJobs: readonly EvalJob[] = [1, 2, 3, 4, 5].map((id) => ({
  id,
  title: `Job ${id}`,
  descriptionText: `desc ${id}`,
}));

const example: EvalExample = {
  profile,
  candidateJobs: [...candidateJobs],
  expectedGoodIds: [1, 3],
};

/** A ranker that returns a fixed ordering, ignoring its inputs — lets the test pin metric math. */
const fixedRanker = (order: number[]): Ranker => () => Promise.resolve(order);

describe("scoreRanker — permutation guard", () => {
  it("accepts a ranking that is a permutation of the candidate ids", async () => {
    const metrics = await scoreRanker(fixedRanker([1, 2, 3, 4, 5]), [example]);
    // One example × DEFAULT_KS (3,5,10) → three rows.
    expect(metrics.map((m) => m.k)).toEqual([3, 5, 10]);
  });

  it("rejects a ranking with the wrong number of ids (dropped a candidate)", async () => {
    await expect(scoreRanker(fixedRanker([1, 2, 3]), [example])).rejects.toThrow(
      "ranker returned 3 ids for 5 candidates (example backend-ic-1).",
    );
  });

  it("rejects a same-length ranking that is not a permutation (fabricated an id)", async () => {
    await expect(scoreRanker(fixedRanker([1, 2, 3, 4, 99]), [example])).rejects.toThrow(
      "ranker output is not a permutation of candidate ids (example backend-ic-1).",
    );
  });
});

describe("scoreRanker — metric math (frozen fixture)", () => {
  it("scores the identity ranking [1,2,3,4,5] with good={1,3} at each k", async () => {
    const [at3, at5, at10] = await scoreRanker(fixedRanker([1, 2, 3, 4, 5]), [example]);

    // k=3: top3 = [1,2,3]; hits {1,3}=2; precision = 2/min(3,5); recall = 2/2; ndcg = 1.5 / (1 + 1/log2 3).
    expect(at3).toMatchObject({ k: 3, recall: 1 });
    expect(at3?.precision).toBeCloseTo(2 / 3, 12);
    expect(at3?.ndcg).toBeCloseTo(0.9197207891481876, 12);

    // k=5: precision divides by min(5,5)=5 → 0.4; recall and ndcg unchanged (all relevant already in top-3).
    expect(at5).toMatchObject({ k: 5, recall: 1 });
    expect(at5?.precision).toBeCloseTo(0.4, 12);
    expect(at5?.ndcg).toBeCloseTo(0.9197207891481876, 12);

    // k=10: denom = min(10, ranked.length=5) = 5, so precision stays 0.4 (a small pool isn't penalized).
    expect(at10).toMatchObject({ k: 10, recall: 1 });
    expect(at10?.precision).toBeCloseTo(0.4, 12);
    expect(at10?.ndcg).toBeCloseTo(0.9197207891481876, 12);
  });

  it("yields NaN recall and ndcg when the example has no relevant ids (undefined ratios)", async () => {
    const noGood: EvalExample = { ...example, expectedGoodIds: [] };
    const [at3] = await scoreRanker(fixedRanker([1, 2, 3, 4, 5]), [noGood]);
    expect(at3?.precision).toBe(0);
    expect(at3?.recall).toBeNaN();
    expect(at3?.ndcg).toBeNaN();
  });
});
