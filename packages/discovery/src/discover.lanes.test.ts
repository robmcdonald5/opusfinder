import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyCounts, resolveLanes, selectLanes, type DiscoveryCounts } from "./discover";
import type { CompanyRecord, SeedLane } from "./seed";

// Unit tests for the per-lane discovery loop (`selectLanes` + `resolveLanes`) over stub lanes —
// offline, deterministic, no network, no db. Ports scripts/test-lanes.ts to describe/it/expect and
// adds the empty-lane, multi-isolated-failure, intra-lane-dedupe, and drop-tally-SUM edges. Covers: lane
// SELECTION ([]/omit = all, NOT zero; unknown name → empty; workerOnly → workerSafe only; compose);
// the two N>1 RESOLUTION traps (cross-lane dedupe collapses a shared (source,slug); named drop
// tallies SUM, not clobber); per-lane counters accumulate; opts.source scope-through; ISOLATED vs
// FAIL-LOUD lane failures; and emptyCounts field init + per-call independence.

// Stub lanes (no network). laneA and laneB both emit greenhouse:acme — it must collapse to ONE. Board
// URLs copied verbatim from scripts/test-lanes.ts.
const laneA: SeedLane = {
  name: "a",
  workerSafe: true,
  fetch: async (): Promise<CompanyRecord[]> => [
    { ats_links: ["https://boards.greenhouse.io/acme", "https://jobs.lever.co/foo"] },
  ],
};
const laneB: SeedLane = {
  name: "b",
  workerSafe: true,
  fetch: async (): Promise<CompanyRecord[]> => [
    { ats_links: ["https://boards.greenhouse.io/acme", "https://jobs.ashbyhq.com/bar"] },
  ],
};
// A single lane whose records emit the SAME (source, slug) twice — must collapse to ONE candidate.
const laneDup: SeedLane = {
  name: "dup",
  workerSafe: true,
  fetch: async (): Promise<CompanyRecord[]> => [
    { ats_links: ["https://boards.greenhouse.io/acme", "https://boards.greenhouse.io/acme"] },
  ],
};
// A lane whose fetch resolves to zero records → zero candidates, tallied as 0 (no throw).
const laneEmpty: SeedLane = {
  name: "empty",
  workerSafe: true,
  fetch: async (): Promise<CompanyRecord[]> => [],
};
const laneBoom: SeedLane = {
  name: "boom",
  workerSafe: true,
  fetch: async (): Promise<CompanyRecord[]> => {
    throw new Error("simulated 500");
  },
};
const laneBoom2: SeedLane = {
  name: "boom2",
  workerSafe: true,
  fetch: async (): Promise<CompanyRecord[]> => {
    throw new Error("simulated 503");
  },
};
const laneFatal: SeedLane = {
  name: "fatal",
  workerSafe: true,
  failLoud: true,
  fetch: async (): Promise<CompanyRecord[]> => {
    throw new Error("core seed broken");
  },
};
const laneNode: SeedLane = {
  name: "node",
  workerSafe: false,
  fetch: async (): Promise<CompanyRecord[]> => [],
};
// Lanes whose links ONLY hit drop buckets (zero candidates) — used to prove badUrl / deferredNoAdapter
// / invalidSlug ACCUMULATE across lanes (an Object.assign clobber would leave them at ONE lane's value).
const laneDropX: SeedLane = {
  name: "dropx",
  workerSafe: true,
  fetch: async (): Promise<CompanyRecord[]> => [
    {
      ats_links: [
        "not a url", // badUrl (new URL throws)
        "https://acme.bamboohr.com/careers", // deferredNoAdapter (no covered adapter)
        "https://jobs.ashbyhq.com/Bad%20Slug", // invalidSlug (% fails the floor)
      ],
    },
  ],
};
const laneDropY: SeedLane = {
  name: "dropy",
  workerSafe: true,
  fetch: async (): Promise<CompanyRecord[]> => [
    {
      ats_links: [
        "also not a url", // badUrl
        "https://foo.workday.com/careers", // deferredNoAdapter
        "https://boards.greenhouse.io/Bad%20Co", // invalidSlug
      ],
    },
  ],
};

const names = (lanes: SeedLane[]): string[] => lanes.map((l) => l.name);
const keys = (candidates: { source: string; slug: string }[]): string[] =>
  candidates.map((c) => `${c.source}:${c.slug}`);

describe("selectLanes — name/worker filtering", () => {
  const registry: SeedLane[] = [laneA, laneB, laneNode];

  it("omit opts.lanes → every registered lane", () => {
    expect(names(selectLanes(registry, {}))).toEqual(["a", "b", "node"]);
  });

  it("opts.lanes=[] → ALL lanes (empty means all, NOT zero)", () => {
    expect(names(selectLanes(registry, { lanes: [] }))).toEqual(["a", "b", "node"]);
  });

  it("opts.lanes=['a'] → restrict to that lane", () => {
    expect(names(selectLanes(registry, { lanes: ["a"] }))).toEqual(["a"]);
  });

  it("opts.lanes=['typo'] → empty set (no lane matches)", () => {
    expect(names(selectLanes(registry, { lanes: ["typo"] }))).toEqual([]);
  });

  it("workerOnly:true drops workerSafe:false lanes", () => {
    expect(names(selectLanes(registry, { workerOnly: true }))).toEqual(["a", "b"]);
  });

  it("lanes + workerOnly compose (named node lane still dropped for being Node-only)", () => {
    expect(names(selectLanes(registry, { lanes: ["a", "node"], workerOnly: true }))).toEqual(["a"]);
  });
});

describe("resolveLanes — cross-lane merge + dedupe (laneA + laneB)", () => {
  let counts: DiscoveryCounts;
  beforeEach(() => {
    counts = emptyCounts();
  });

  it("shared greenhouse:acme collapses to ONE; result is the sorted union", async () => {
    const candidates = await resolveLanes([laneA, laneB], counts, {});
    expect(keys(candidates).sort()).toEqual(["ashby:bar", "greenhouse:acme", "lever:foo"]);
  });

  it("counts.candidates is the merged, deduped total (3)", async () => {
    await resolveLanes([laneA, laneB], counts, {});
    expect(counts.candidates).toBe(3);
  });

  it("counts.atsLinks SUMs across lanes (4) — not clobbered to 2", async () => {
    await resolveLanes([laneA, laneB], counts, {});
    expect(counts.atsLinks).toBe(4);
  });

  it("counts.seedRecords sums one record per lane (2)", async () => {
    await resolveLanes([laneA, laneB], counts, {});
    expect(counts.seedRecords).toBe(2);
  });

  it("per-lane counters: lane a contributes 2, lane b contributes 1 (shared pair deduped out)", async () => {
    await resolveLanes([laneA, laneB], counts, {});
    expect(counts.lane_a_candidates).toBe(2);
    expect(counts.lane_b_candidates).toBe(1);
  });
});

describe("resolveLanes — source scoping", () => {
  it("opts.source:'greenhouse' keeps only greenhouse, drops the lever link", async () => {
    const counts = emptyCounts();
    const candidates = await resolveLanes([laneA], counts, { source: "greenhouse" });
    expect(keys(candidates)).toEqual(["greenhouse:acme"]);
    expect(counts.candidates).toBe(1);
    expect(counts.lane_a_candidates).toBe(1);
  });
});

describe("resolveLanes — isolated (non-failLoud) lane failures", () => {
  beforeEach(() => {
    // The isolated path logs the failure shape to console.error — silence it for a clean run.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("a throwing lane tallies lane_<name>_error and the healthy lane still yields", async () => {
    const counts = emptyCounts();
    const candidates = await resolveLanes([laneBoom, laneA], counts, {});
    expect(counts.lane_boom_error).toBe(1);
    expect(candidates.length).toBe(2);
    expect(counts.candidates).toBe(2);
  });

  it("TWO isolated failures each stamp their own error; a healthy TRAILING lane still contributes", async () => {
    const counts = emptyCounts();
    const candidates = await resolveLanes([laneBoom, laneBoom2, laneA], counts, {});
    expect(counts.lane_boom_error).toBe(1);
    expect(counts.lane_boom2_error).toBe(1);
    expect(keys(candidates).sort()).toEqual(["greenhouse:acme", "lever:foo"]);
    expect(counts.candidates).toBe(2);
  });
});

describe("resolveLanes — fail-loud (core seed) failure", () => {
  it("a failLoud lane re-throws (run-fatal), not swallowed", async () => {
    const counts = emptyCounts();
    await expect(resolveLanes([laneFatal, laneA], counts, {})).rejects.toThrow(/core seed broken/);
  });

  it("the error is still tallied before the re-throw", async () => {
    const counts = emptyCounts();
    await expect(resolveLanes([laneFatal, laneA], counts, {})).rejects.toThrow(/core seed broken/);
    expect(counts.lane_fatal_error).toBe(1);
  });
});

describe("resolveLanes — dedupe within a run", () => {
  it("[laneA, laneA] adds no NEW candidates; lane_a_candidates accumulates (2 + 0)", async () => {
    const counts = emptyCounts();
    await resolveLanes([laneA, laneA], counts, {});
    expect(counts.candidates).toBe(2);
    expect(counts.lane_a_candidates).toBe(2);
  });

  // Intra-lane dedupe happens inside resolveSeed's per-call `seen` (before resolveLanes' cross-lane
  // `seen` is reached). The cross-lane guard itself is covered by [laneA,laneB] and [laneA,laneA] above.
  it("a lane with duplicate links yields ONE candidate (intra-lane dedupe via resolveSeed)", async () => {
    const counts = emptyCounts();
    const candidates = await resolveLanes([laneDup], counts, {});
    expect(keys(candidates)).toEqual(["greenhouse:acme"]);
    expect(candidates.length).toBe(1);
    expect(counts.candidates).toBe(1);
    expect(counts.lane_dup_candidates).toBe(1);
  });
});

describe("resolveLanes — empty lanes", () => {
  it("a lane that resolves [] → 0 candidates, lane_<name>_candidates=0, no throw", async () => {
    const counts = emptyCounts();
    const candidates = await resolveLanes([laneEmpty], counts, {});
    expect(candidates).toEqual([]);
    expect(counts.candidates).toBe(0);
    expect(counts.lane_empty_candidates).toBe(0);
  });

  it("an empty lane alongside a healthy lane leaves the healthy tallies unaffected", async () => {
    const counts = emptyCounts();
    const candidates = await resolveLanes([laneEmpty, laneA], counts, {});
    expect(keys(candidates).sort()).toEqual(["greenhouse:acme", "lever:foo"]);
    expect(counts.candidates).toBe(2);
    expect(counts.lane_empty_candidates).toBe(0);
    expect(counts.lane_a_candidates).toBe(2);
  });

  it("resolveLanes([]) → [] with counts.candidates=0", async () => {
    const counts = emptyCounts();
    const candidates = await resolveLanes([], counts, {});
    expect(candidates).toEqual([]);
    expect(counts.candidates).toBe(0);
  });
});

describe("resolveLanes — drop-reason tallies accumulate across lanes (SUM, not clobber)", () => {
  it("badUrl / deferredNoAdapter / invalidSlug SUM over two all-drop lanes", async () => {
    const counts = emptyCounts();
    const candidates = await resolveLanes([laneDropX, laneDropY], counts, {});
    expect(candidates).toEqual([]);
    expect(counts.candidates).toBe(0);
    expect(counts.atsLinks).toBe(6); // 3 links per lane, summed
    expect(counts.badUrl).toBe(2); // 1 per lane, summed (a clobber would leave 1)
    expect(counts.deferredNoAdapter).toBe(2);
    expect(counts.invalidSlug).toBe(2);
  });
});

describe("emptyCounts", () => {
  it("initializes every named field to 0", () => {
    expect(emptyCounts()).toStrictEqual({
      seedRecords: 0,
      atsLinks: 0,
      badUrl: 0,
      deferredNoAdapter: 0,
      invalidSlug: 0,
      candidates: 0,
      alreadyActive: 0,
      probeWorklist: 0,
      probed: 0,
      live: 0,
      liveEmpty: 0,
      absent: 0,
      indeterminate: 0,
      transientFailed: 0,
      upserted: 0,
      reprobed: 0,
      refreshedLive: 0,
      markedFailed: 0,
      reprobeInconclusive: 0,
      deactivated: 0,
      jobsClosedOnDeactivation: 0,
      wouldCloseOnDeactivation: 0,
    });
  });

  it("returns a fresh independent object each call (mutating one does not affect another)", () => {
    const a = emptyCounts();
    const b = emptyCounts();
    a.candidates = 99;
    a.lane_x_error = 7;
    expect(b.candidates).toBe(0);
    expect(b.lane_x_error).toBeUndefined();
  });
});
