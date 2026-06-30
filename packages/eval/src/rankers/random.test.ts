import { describe, expect, it } from "vitest";

import type { EvalJob, EvalProfile } from "../types";
import { randomRanker } from "./random";

// Leaf pure-unit. The random stub is the baseline floor every real ranker must clear, and its
// committed report must NOT churn between runs — so the shuffle is a Fisher-Yates seeded SOLELY from
// `profile.id` (via FNV-1a + mulberry32). These tests lock that contract: same id → byte-identical
// permutation, the output is always a permutation of the candidate ids, and the order keys on the id
// alone (other profile fields don't perturb it). The exact permutations are FROZEN — derived once from
// the shipped rng, so a change to hashString/mulberry32/the loop fails loudly instead of silently
// re-baselining the report.

const CANDIDATE_IDS = [101, 102, 103, 104, 105, 106, 107] as const;

const candidates: readonly EvalJob[] = CANDIDATE_IDS.map((id) => ({
  id,
  title: `Job ${id}`,
  descriptionText: `Description for ${id}`,
}));

const profile = (id: string): EvalProfile => ({
  id,
  summary: "irrelevant to ordering",
  skills: ["Go"],
  targetRoles: ["Backend Engineer"],
});

describe("randomRanker", () => {
  it("returns a permutation of the candidate ids", async () => {
    const ranked = await randomRanker(profile("backend-ic-1"), [...candidates]);
    expect([...ranked].sort((a, b) => a - b)).toEqual([...CANDIDATE_IDS]);
  });

  it("is deterministic — the same profile.id yields the same permutation across runs", async () => {
    const a = await randomRanker(profile("backend-ic-1"), [...candidates]);
    const b = await randomRanker(profile("backend-ic-1"), [...candidates]);
    expect(a).toEqual(b);
  });

  it("matches the frozen permutation for a known seed (regression-locks the rng contract)", async () => {
    const ranked = await randomRanker(profile("backend-ic-1"), [...candidates]);
    expect(ranked).toEqual([103, 106, 104, 101, 102, 105, 107]);
  });

  it("keys on profile.id alone — other profile fields don't perturb the order", async () => {
    const lean = await randomRanker({ id: "backend-ic-1", summary: "", skills: [], targetRoles: [] }, [
      ...candidates,
    ]);
    expect(lean).toEqual([103, 106, 104, 101, 102, 105, 107]);
  });

  it("a different profile.id produces a different permutation", async () => {
    const ranked = await randomRanker(profile("frontend-ic-2"), [...candidates]);
    expect(ranked).toEqual([103, 107, 102, 106, 101, 105, 104]);
  });

  it("returns an empty ranking for an empty candidate pool (Fisher-Yates loop-guard boundary)", async () => {
    const ranked = await randomRanker(profile("backend-ic-1"), []);
    expect(ranked).toEqual([]);
  });

  it("does not mutate the caller's candidate array", async () => {
    const pool = [...candidates];
    await randomRanker(profile("backend-ic-1"), pool);
    expect(pool.map((j) => j.id)).toEqual([...CANDIDATE_IDS]);
  });
});
