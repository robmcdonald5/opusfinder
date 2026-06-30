import type { PromptPreferences, StructuredProfile } from "@opusfinder/shared";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CHUNK_SIZE,
  rerankCandidates,
  type RerankCall,
  type RerankCandidate,
  type RerankScore,
} from "./index";

// Leaf pure-unit. rerankCandidates is the digest's ordering core with the LLM round-trip INJECTED, so
// these tests pass a deterministic fake `call` and lock the orchestration contract the digest + eval both
// depend on: scores clamp into [0,1] and non-finite scores are DROPPED (a NaN would make the sort
// comparator non-transitive and land junk in digest_items.score); chunking respects DEFAULT_CHUNK_SIZE;
// the result is ALWAYS a full permutation (scored desc with stable ties, omissions backfilled in original
// order — eval's assertPermutation requires it); and an error from the call propagates. Ports the scoring
// half of scripts/test-rerank-prefs.ts plus net-new edge coverage.
const PROFILE: StructuredProfile = {
  summary: "Software engineer with a few internships; recent CS grad looking for a first full-time role.",
  skills: ["TypeScript", "Node.js", "PostgreSQL"],
  targetRoles: ["Software Engineer", "Backend Engineer"],
};

const EMPTY_PREFS: PromptPreferences = {
  yoeMin: null,
  yoeMax: null,
  minSalary: null,
  maxSalary: null,
  dealbreakers: [],
};

// A low target YoE band (0-2 yrs) — the declared-level signal the rubric treats as authoritative.
const JUNIOR_PREFS: PromptPreferences = {
  yoeMin: 0,
  yoeMax: 2,
  minSalary: 120000,
  maxSalary: null,
  dealbreakers: ["crypto"],
};

const CANDIDATES: RerankCandidate[] = [
  { id: 1, title: "Staff Software Engineer", descriptionText: "Own org-wide technical strategy, 10+ yrs." },
  { id: 2, title: "Software Engineer I", descriptionText: "New-grad backend role, Node + Postgres, mentorship." },
  { id: 3, title: "Senior Platform Engineer", descriptionText: "Lead platform work, 6+ yrs." },
];

/** A fake RerankCall modeling the rubric's declared-level rule: it reads the system for a low declared YoE
 *  band and, when present, down-scores obviously over-leveled titles. No network/model — proves prefs reach
 *  the `system` the scorer sees. */
function levelAwareStub(): RerankCall {
  return async (system, cands) => {
    const wantsLow = /Target years of experience: 0-2\b/.test(system);
    return cands.map((c) => {
      const overLeveled = /\b(staff|principal|director|senior)\b/i.test(c.title);
      return { id: c.id, score: wantsLow && overLeveled ? 0.1 : 0.8 };
    });
  };
}

/** A fake RerankCall that returns a fixed, caller-supplied score map and records the chunk sizes it was
 *  handed (so chunking boundaries are assertable). Omits any id not in `byId` (drives the backfill path). */
function fixedScoreStub(byId: Record<number, number>): { call: RerankCall; chunkSizes: number[] } {
  const chunkSizes: number[] = [];
  const call: RerankCall = vi.fn<RerankCall>(async (_system, cands) => {
    chunkSizes.push(cands.length);
    // Omit any id not in `byId` (drives the backfill path). Capture-then-guard so the score narrows to a
    // number under noUncheckedIndexedAccess — `c.id in byId` does not narrow an index access.
    return cands.flatMap<RerankScore>((c) => {
      const score = byId[c.id];
      return score === undefined ? [] : [{ id: c.id, score }];
    });
  });
  return { call, chunkSizes };
}

/** N candidates with ids 1..N (titles are inert here — scoring is driven by the fake call). */
function makeCandidates(n: number): RerankCandidate[] {
  return Array.from({ length: n }, (_v, i) => ({
    id: i + 1,
    title: `Role ${i + 1}`,
    descriptionText: `desc ${i + 1}`,
  }));
}

describe("rerankCandidates — prefs wired into scoring", () => {
  it("a low declared YoE band drops the over-leveled role below the level-matched one", async () => {
    const withLow = await rerankCandidates(PROFILE, CANDIDATES, levelAwareStub(), { prefs: JUNIOR_PREFS });
    expect(withLow.orderedIds[0]).toBe(2); // level-matched "Software Engineer I" ranks first
    expect(withLow.orderedIds.indexOf(1)).toBeGreaterThan(withLow.orderedIds.indexOf(2));
  });

  it("declared level observably changes the order vs no-prefs (proves prefs reach the scorer)", async () => {
    const withLow = await rerankCandidates(PROFILE, CANDIDATES, levelAwareStub(), { prefs: JUNIOR_PREFS });
    const noLevel = await rerankCandidates(PROFILE, CANDIDATES, levelAwareStub(), { prefs: EMPTY_PREFS });
    expect(withLow.orderedIds).not.toEqual(noLevel.orderedIds);
  });
});

describe("rerankCandidates — score clamp + non-finite filter", () => {
  it("clamps out-of-range finite scores into [0,1]", async () => {
    const { call } = fixedScoreStub({ 1: 5, 2: -3, 3: 0.5 });
    const result = await rerankCandidates(PROFILE, CANDIDATES, call);
    expect(result.scores.get(1)).toBe(1); // 5 → clamped to 1
    expect(result.scores.get(2)).toBe(0); // -3 → clamped to 0
    expect(result.scores.get(3)).toBe(0.5);
    expect(result.orderedIds).toEqual([1, 3, 2]); // 1.0, 0.5, 0.0
  });

  it.each<[string, number]>([
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("drops a %s score (unscored → backfilled, never stored)", async (_label, bad) => {
    const { call } = fixedScoreStub({ 1: bad, 2: bad, 3: 0.7 });
    const result = await rerankCandidates(PROFILE, CANDIDATES, call);
    expect(result.scores.has(1)).toBe(false);
    expect(result.scores.has(2)).toBe(false);
    expect(result.scores.get(3)).toBe(0.7);
    // The one scored id leads; the two dropped ids backfill in original order.
    expect(result.orderedIds).toEqual([3, 1, 2]);
  });
});

describe("rerankCandidates — chunking around DEFAULT_CHUNK_SIZE", () => {
  it("exposes the documented default chunk size", () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(13);
  });

  it.each<[number, number[]]>([
    [DEFAULT_CHUNK_SIZE - 1, [12]], // under one chunk
    [DEFAULT_CHUNK_SIZE, [13]], // exactly one chunk
    [DEFAULT_CHUNK_SIZE + 1, [13, 1]], // boundary: spills one into a second chunk
    [DEFAULT_CHUNK_SIZE * 2, [13, 13]], // two full chunks
  ])("splits %d candidates into chunks %j at the default size", async (n, expected) => {
    const { call, chunkSizes } = fixedScoreStub({});
    await rerankCandidates(PROFILE, makeCandidates(n), call);
    expect(chunkSizes).toEqual(expected);
  });

  it.each<[string, number | undefined]>([
    ["zero", 0],
    ["negative", -5],
  ])("coerces a %s chunkSize to 1 (never a zero-width infinite loop)", async (_label, chunkSize) => {
    const { call, chunkSizes } = fixedScoreStub({});
    await rerankCandidates(PROFILE, makeCandidates(3), call, { chunkSize });
    expect(chunkSizes).toEqual([1, 1, 1]);
  });
});

describe("rerankCandidates — empty input", () => {
  it("returns an empty ordering and never invokes the call for zero candidates", async () => {
    const { call, chunkSizes } = fixedScoreStub({});
    const result = await rerankCandidates(PROFILE, [], call);
    expect(result.orderedIds).toEqual([]);
    expect(result.scores.size).toBe(0);
    expect(call).not.toHaveBeenCalled();
    expect(chunkSizes).toEqual([]); // no chunks → no call
  });
});

describe("rerankCandidates — permutation completeness + ordering", () => {
  it("returns a full permutation of input ids even when the call omits some", async () => {
    const candidates = makeCandidates(6);
    // Score only a shuffled subset; ids 2, 4, 6 are omitted → must backfill.
    const { call } = fixedScoreStub({ 5: 0.9, 1: 0.4, 3: 0.6 });
    const result = await rerankCandidates(PROFILE, candidates, call);

    expect([...result.orderedIds].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    // Scored ids first by score desc, then the omitted ids backfilled in original order.
    expect(result.orderedIds).toEqual([5, 3, 1, 2, 4, 6]);
  });

  it("breaks score ties by original input order (stable sort)", async () => {
    const candidates = makeCandidates(3);
    const { call } = fixedScoreStub({ 1: 0.5, 2: 0.5, 3: 0.5 });
    const result = await rerankCandidates(PROFILE, candidates, call);
    expect(result.orderedIds).toEqual([1, 2, 3]);
  });

  it("ignores hallucinated ids that were not in the chunk", async () => {
    // id 99 is not a candidate — it must never enter the scores map or the ordering.
    const call: RerankCall = async (_system, cands) => [
      ...cands.map((c) => ({ id: c.id, score: 0.3 })),
      { id: 99, score: 1 },
    ];
    const result = await rerankCandidates(PROFILE, CANDIDATES, call);
    expect(result.scores.has(99)).toBe(false);
    expect(result.orderedIds).not.toContain(99);
    expect(result.orderedIds).toHaveLength(CANDIDATES.length);
  });
});

describe("rerankCandidates — error propagation", () => {
  it("rejects when the injected call throws", async () => {
    const call: RerankCall = vi.fn(async () => {
      throw new Error("rerank call failed");
    });
    await expect(rerankCandidates(PROFILE, CANDIDATES, call)).rejects.toThrow("rerank call failed");
  });
});
