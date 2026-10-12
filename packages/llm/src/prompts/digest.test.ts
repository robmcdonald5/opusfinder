import type { StructuredProfile } from "@opusfinder/shared";
import { describe, expect, it } from "vitest";

import { buildDigestSystem, DIGEST_SYNTHESIS_SYSTEM } from "./digest";

// The synthesis system is the cached prefix shared across a user's batch requests: an unanswered user's
// prefs must leave it byte-identical to the no-prefs system, and set prefs ride after that exact prefix.
const PROFILE: StructuredProfile = {
  summary: "Backend engineer, ~4 yrs, Go services.",
  skills: ["Go", "PostgreSQL"],
  targetRoles: ["Backend Engineer"],
};

describe("buildDigestSystem", () => {
  it("keeps the no-prefs system as the exact prefix, and appends set prefs after it", () => {
    const base = buildDigestSystem(PROFILE);
    const empty = { yoeMin: null, yoeMax: null, minSalary: null, maxSalary: null, dealbreakers: [] };
    const withPrefs = buildDigestSystem(PROFILE, { ...empty, yoeMin: 2, yoeMax: 5 });

    expect(base.startsWith(DIGEST_SYNTHESIS_SYSTEM)).toBe(true);
    expect(buildDigestSystem(PROFILE, empty)).toBe(base);
    expect(withPrefs.startsWith(`${base}\n\n=== Candidate stated preferences ===\n`)).toBe(true);
    expect(withPrefs).toContain("Target years of experience: 2-5");
  });
});
