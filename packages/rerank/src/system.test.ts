import type { PromptPreferences, StructuredProfile } from "@opusfinder/shared";
import { describe, expect, it } from "vitest";

import { buildRerankSystem, RERANK_RUBRIC } from "./index";

// Leaf pure-unit (no creds, no LLM). Locks the cacheable `system` skeleton: the rubric+profile prefix is
// the prompt-cache key, so the prefs block MUST ride a labeled tail that only appears when a field is set
// — an un-answered user's prefix stays byte-identical to the no-prefs path (no per-user cache bust), and a
// set field renders exactly once with its bound. A regression here silently busts the cache or drops a
// judgment-context signal. Ports the buildRerankSystem half of scripts/test-rerank-prefs.ts.
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

// A low target YoE band (0-2 yrs) + an only-min salary + a dealbreaker — the declared level signal.
const JUNIOR_PREFS: PromptPreferences = {
  yoeMin: 0,
  yoeMax: 2,
  minSalary: 120000,
  maxSalary: null,
  dealbreakers: ["crypto"],
};

describe("buildRerankSystem — cacheable prefix shape", () => {
  it("starts with the stable rubric, then the labeled profile block", () => {
    const system = buildRerankSystem(PROFILE);
    expect(system.startsWith(RERANK_RUBRIC)).toBe(true);
    expect(system).toContain("=== Candidate profile ===");
  });

  it("undefined prefs equals the no-arg system (the unset default path)", () => {
    expect(buildRerankSystem(PROFILE, undefined)).toBe(buildRerankSystem(PROFILE));
  });

  it("all-empty prefs is byte-identical to no-prefs (no per-user prompt-cache bust)", () => {
    const noPrefs = buildRerankSystem(PROFILE);
    expect(buildRerankSystem(PROFILE, EMPTY_PREFS)).toBe(noPrefs);
    expect(noPrefs).not.toContain("Candidate stated preferences");
  });
});

describe("buildRerankSystem — appended prefs block", () => {
  const noPrefs = buildRerankSystem(PROFILE);
  const withPrefs = buildRerankSystem(PROFILE, JUNIOR_PREFS);

  it("appends a labeled block to the EXACT no-prefs prefix (prefix stays cache-stable)", () => {
    expect(withPrefs.startsWith(noPrefs)).toBe(true);
    expect(withPrefs).toContain("=== Candidate stated preferences ===");
  });

  it("renders the declared YoE band (0-2)", () => {
    expect(withPrefs).toContain("Target years of experience: 0-2");
  });

  it("renders an only-min salary as 'from' with no ceiling on its line", () => {
    expect(withPrefs).toContain("Salary preference: from 120000");
    // Scope the negative to the salary LINE — the rubric prose itself contains "up to"/"-" elsewhere.
    expect(/Salary preference:.*(?:up to|-)/.test(withPrefs)).toBe(false);
  });

  it("renders the dealbreaker avoid line", () => {
    expect(withPrefs).toContain("Dealbreakers (avoid): crypto");
  });

  it("joins multiple dealbreakers with ', ' on a single avoid line", () => {
    const multi = buildRerankSystem(PROFILE, { ...JUNIOR_PREFS, dealbreakers: ["crypto", "gambling", "adtech"] });
    expect(multi).toContain("Dealbreakers (avoid): crypto, gambling, adtech");
  });
});

describe("buildRerankSystem — only-set fields render (each bound independent)", () => {
  // Truth table over the bounded-range edges the prefs block must render gracefully: only-max salary,
  // both-bounds yoe, only-max yoe. Each set field appears exactly once; unset fields emit no line.
  it.each<[string, PromptPreferences, string, string]>([
    [
      "only-max salary → 'up to'",
      { yoeMin: null, yoeMax: null, minSalary: null, maxSalary: 200000, dealbreakers: [] },
      "Salary preference: up to 200000",
      "Target years of experience",
    ],
    [
      "both-bounds yoe → dash range",
      { yoeMin: 3, yoeMax: 6, minSalary: null, maxSalary: null, dealbreakers: [] },
      "Target years of experience: 3-6",
      "Salary preference",
    ],
    [
      "only-max yoe → 'at most'",
      { yoeMin: null, yoeMax: 5, minSalary: null, maxSalary: null, dealbreakers: [] },
      "Target years of experience: at most 5",
      // Dealbreakers render as "Dealbreakers (avoid):" — use the real prefix so the absent-check can fail.
      "Dealbreakers (avoid)",
    ],
  ])("%s", (_label, prefs, expectedLine, absentLabel) => {
    const system = buildRerankSystem(PROFILE, prefs);
    expect(system).toContain("=== Candidate stated preferences ===");
    expect(system).toContain(expectedLine);
    // The unset sibling field must not emit a line inside the prefs block.
    const block = system.split("=== Candidate stated preferences ===")[1];
    expect(block).not.toContain(`${absentLabel}:`);
  });
});
