/**
 * Unit tests for the per-lane discovery loop (`selectLanes` + `resolveLanes`) over stub lanes —
 * offline, deterministic, no network, no db. Covers: lane SELECTION (opts.lanes restrict; []/omit = all,
 * NOT zero; unknown name → empty; workerOnly → workerSafe only); the two N>1 RESOLUTION traps (cross-lane
 * dedupe collapses a shared (source,slug); named drop tallies SUM, not clobber); per-lane counters
 * accumulate; opts.source scope-through; and FAIL-LOUD (core seed re-throws) vs ISOLATED lane failures.
 * Run with `pnpm --filter @opusfinder/discovery test:lanes`. node:assert/strict → non-zero exit on failure.
 */
import assert from "node:assert/strict";

import { emptyCounts, resolveLanes, selectLanes } from "../src/discover";
import type { SeedLane } from "../src/seed";

// Stub lanes (no network). laneA and laneB both emit greenhouse:acme — it must collapse to ONE.
const laneA: SeedLane = {
  name: "a",
  workerSafe: true,
  fetch: async () => [
    { ats_links: ["https://boards.greenhouse.io/acme", "https://jobs.lever.co/foo"] },
  ],
};
const laneB: SeedLane = {
  name: "b",
  workerSafe: true,
  fetch: async () => [
    { ats_links: ["https://boards.greenhouse.io/acme", "https://jobs.ashbyhq.com/bar"] },
  ],
};
const laneBoom: SeedLane = {
  name: "boom",
  workerSafe: true,
  fetch: async () => {
    throw new Error("simulated 500");
  },
};
const laneFatal: SeedLane = {
  name: "fatal",
  workerSafe: true,
  failLoud: true,
  fetch: async () => {
    throw new Error("core seed broken");
  },
};
const laneNode: SeedLane = { name: "node", workerSafe: false, fetch: async () => [] };

{
  const registry = [laneA, laneB, laneNode];
  const names = (lanes: SeedLane[]) => lanes.map((l) => l.name);
  assert.deepEqual(names(selectLanes(registry, {})), ["a", "b", "node"], "omit = all lanes");
  assert.deepEqual(names(selectLanes(registry, { lanes: [] })), ["a", "b", "node"], "[] = all (NOT zero)");
  assert.deepEqual(names(selectLanes(registry, { lanes: ["a"] })), ["a"], "restrict by name");
  assert.deepEqual(names(selectLanes(registry, { lanes: ["typo"] })), [], "unknown name → empty set");
  assert.deepEqual(names(selectLanes(registry, { workerOnly: true })), ["a", "b"], "workerOnly drops workerSafe:false");
}

{
  const counts = emptyCounts();
  const candidates = await resolveLanes([laneA, laneB], counts, {});
  assert.deepEqual(
    candidates.map((c) => `${c.source}:${c.slug}`).sort(),
    ["ashby:bar", "greenhouse:acme", "lever:foo"],
    "shared greenhouse:acme collapses to ONE across lanes",
  );
  assert.equal(counts.candidates, 3, "merged, deduped candidate count");
  assert.equal(counts.atsLinks, 4, "atsLinks SUM across lanes (Object.assign would leave 2)");
  assert.equal(counts.seedRecords, 2, "one record per lane, summed");
  assert.equal(counts.lane_a_candidates, 2, "lane a contributed 2 new");
  assert.equal(counts.lane_b_candidates, 1, "lane b contributed 1 (shared greenhouse:acme deduped out)");
}

{
  const counts = emptyCounts();
  const candidates = await resolveLanes([laneA], counts, { source: "greenhouse" });
  assert.deepEqual(
    candidates.map((c) => `${c.source}:${c.slug}`),
    ["greenhouse:acme"],
    "source-scoped run keeps only greenhouse, drops the lever link",
  );
}

{
  const counts = emptyCounts();
  const candidates = await resolveLanes([laneBoom, laneA], counts, {});
  assert.equal(counts.lane_boom_error, 1, "throwing lane tallies lane_<name>_error");
  assert.equal(candidates.length, 2, "the healthy lane still produced greenhouse:acme + lever:foo");
  assert.equal(counts.candidates, 2, "counts.candidates reflects only the healthy lane");
}

{
  const counts = emptyCounts();
  await assert.rejects(
    resolveLanes([laneFatal, laneA], counts, {}),
    /core seed broken/,
    "a failLoud lane's fetch error is re-thrown (run-fatal), not swallowed",
  );
  assert.equal(counts.lane_fatal_error, 1, "the error is still tallied before the re-throw");
}

{
  const counts = emptyCounts();
  await resolveLanes([laneA, laneA], counts, {});
  assert.equal(counts.candidates, 2, "the second identical lane adds no NEW candidates (cross-lane dedupe)");
  assert.equal(counts.lane_a_candidates, 2, "lane_a_candidates accumulates (2 + 0), not last-write-wins");
}

console.log("lanes: offline assertions passed.");
