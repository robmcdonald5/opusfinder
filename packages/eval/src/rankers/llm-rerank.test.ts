import type { RerankCall, RerankScore } from "@opusfinder/rerank";
import { describe, expect, it, vi } from "vitest";

import type { EvalJob, EvalProfile } from "../types";
import { llmRerankRanker, stubRerankCall } from "./llm-rerank";

// Leaf pure-unit with an INJECTED rerank call — no Haiku, no API key. The eval ranker is a thin
// adapter over the shared `rerankCandidates` core: it maps each EvalJob → {id,title,descriptionText},
// passes a cached `system` (rubric + profile) to the call, and returns the core's full ordering. These
// tests lock the adapter contract: scored candidates come back score-descending (ties by input order),
// any candidate the call OMITS is backfilled at the end so the result is always a full permutation
// (`assertPermutation`-safe), and the default `stubRerankCall` is deterministic so the committed report
// is byte-stable.

const profile: EvalProfile = {
  id: "backend-ic-1",
  summary: "Senior backend engineer, Go and Postgres",
  skills: ["Go", "PostgreSQL"],
  targetRoles: ["Staff Backend Engineer"],
};

const candidates: readonly EvalJob[] = [
  { id: 1, title: "Job 1", descriptionText: "desc 1" },
  { id: 2, title: "Job 2", descriptionText: "desc 2" },
  { id: 3, title: "Job 3", descriptionText: "desc 3" },
  { id: 4, title: "Job 4", descriptionText: "desc 4" },
];

describe("llmRerankRanker", () => {
  it("returns the scored candidates best-first and backfills omitted ones at the end", async () => {
    // id 3 is deliberately omitted by the call → it must land last via the core's backfill.
    const scores = new Map<number, number>([
      [1, 0.1],
      [2, 0.9],
      [4, 0.5],
    ]);
    const call: RerankCall = (_system, chunk) =>
      Promise.resolve(
        chunk
          .filter((c) => scores.has(c.id))
          .map((c): RerankScore => ({ id: c.id, score: scores.get(c.id) as number })),
      );

    const ranked = await llmRerankRanker(call)(profile, [...candidates]);
    expect(ranked).toEqual([2, 4, 1, 3]);
  });

  it("maps EvalJob fields into RerankCandidate and passes a profile-bearing system string", async () => {
    const call = vi.fn<RerankCall>((_system, chunk) =>
      Promise.resolve(chunk.map((c): RerankScore => ({ id: c.id, score: 0.5 }))),
    );
    await llmRerankRanker(call)(profile, [...candidates]);

    const [system, passedCandidates] = call.mock.calls[0] as [string, EvalJob[]];
    expect(system).toContain(profile.summary);
    expect(passedCandidates).toEqual([
      { id: 1, title: "Job 1", descriptionText: "desc 1" },
      { id: 2, title: "Job 2", descriptionText: "desc 2" },
      { id: 3, title: "Job 3", descriptionText: "desc 3" },
      { id: 4, title: "Job 4", descriptionText: "desc 4" },
    ]);
  });

  it("breaks an all-equal-score tie by original input order", async () => {
    // Every candidate scored 0.5 → the core's `b.score - a.score || a.idx - b.idx` falls back to input order.
    const call: RerankCall = (_system, chunk) =>
      Promise.resolve(chunk.map((c): RerankScore => ({ id: c.id, score: 0.5 })));
    const ranked = await llmRerankRanker(call)(profile, [...candidates]);
    expect(ranked).toEqual([1, 2, 3, 4]);
  });

  it("returns a full permutation of the candidate ids", async () => {
    const ranked = await llmRerankRanker(stubRerankCall)(profile, [...candidates]);
    expect([...ranked].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("the default stub call is deterministic — same inputs yield the frozen order", async () => {
    const a = await llmRerankRanker()(profile, [...candidates]);
    const b = await llmRerankRanker()(profile, [...candidates]);
    expect(a).toEqual([4, 1, 3, 2]);
    expect(b).toEqual([4, 1, 3, 2]);
  });

  it("the stub ordering depends on the profile (a different profile reorders)", async () => {
    const other: EvalProfile = { ...profile, id: "frontend-ic-2", summary: "Frontend engineer, React" };
    const forFrontend = await llmRerankRanker()(other, [...candidates]);
    // The stub keys on the `system` (which embeds the profile), so a different profile produces a
    // genuinely different ordering — not just a coincidental permutation of the same ids.
    expect(forFrontend).toEqual([2, 1, 4, 3]);
    expect(forFrontend).not.toEqual([4, 1, 3, 2]);
  });
});
