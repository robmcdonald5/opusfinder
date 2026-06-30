import type { PromptPreferences, StructuredProfile } from "@opusfinder/shared";
import { describe, expect, it, vi } from "vitest";

import { buildRerankSystem, rerankCandidates, type RerankCall, type RerankCandidate } from "./index";

// Leaf pure-unit. The `system` string IS the prompt-cache key, so it must be a pure deterministic function
// of (profile, prefs) — equal inputs (even fresh-but-equal objects) MUST yield the identical string — and
// rerankCandidates must build it ONCE and hand the same string to every chunk, so a caching call hits the
// cache on chunks 2..N. A regression that re-derives the system per chunk, or makes it object-identity
// dependent, silently busts the cache on every request. Ports the cache-stability half of the old script.
const PROFILE: StructuredProfile = {
  summary: "Software engineer with a few internships; recent CS grad looking for a first full-time role.",
  skills: ["TypeScript", "Node.js", "PostgreSQL"],
  targetRoles: ["Software Engineer", "Backend Engineer"],
};

const JUNIOR_PREFS: PromptPreferences = {
  yoeMin: 0,
  yoeMax: 2,
  minSalary: 120000,
  maxSalary: null,
  dealbreakers: ["crypto"],
};

const CANDIDATES: RerankCandidate[] = [
  { id: 1, title: "Staff Software Engineer", descriptionText: "Own org-wide technical strategy, 10+ yrs." },
  { id: 2, title: "Software Engineer I", descriptionText: "New-grad backend role, Node + Postgres." },
  { id: 3, title: "Senior Platform Engineer", descriptionText: "Lead platform work, 6+ yrs." },
];

describe("buildRerankSystem — determinism", () => {
  it("two calls with identical inputs return the identical string", () => {
    expect(buildRerankSystem(PROFILE, JUNIOR_PREFS)).toBe(buildRerankSystem(PROFILE, JUNIOR_PREFS));
  });

  it("a fresh-but-equal prefs object yields the same string (no object-identity dependence)", () => {
    const a = buildRerankSystem(PROFILE, { ...JUNIOR_PREFS, dealbreakers: [...JUNIOR_PREFS.dealbreakers] });
    const b = buildRerankSystem(PROFILE, { ...JUNIOR_PREFS, dealbreakers: [...JUNIOR_PREFS.dealbreakers] });
    expect(a).toBe(b);
    expect(a).toBe(buildRerankSystem(PROFILE, JUNIOR_PREFS));
  });
});

describe("rerankCandidates — system built once, identical across chunks", () => {
  it("hands every chunk the IDENTICAL system, equal to buildRerankSystem(profile, prefs)", async () => {
    const systems: string[] = [];
    const call: RerankCall = vi.fn<RerankCall>(async (system, cands) => {
      systems.push(system);
      return cands.map((c) => ({ id: c.id, score: 0.5 }));
    });

    // chunkSize 1 over 3 candidates → 3 calls, all handed the same system string.
    await rerankCandidates(PROFILE, CANDIDATES, call, { prefs: JUNIOR_PREFS, chunkSize: 1 });

    expect(systems).toHaveLength(3);
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).toBe(buildRerankSystem(PROFILE, JUNIOR_PREFS));
  });
});
