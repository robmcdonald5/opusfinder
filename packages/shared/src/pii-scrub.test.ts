import { describe, expect, it } from "vitest";

import { scrubProfilePii } from "./index";

// Defense-in-depth PII scrub contract. The profile is persisted + vectorized, so scrubProfilePii is
// the last guard that machine-detectable PII (emails + phone runs of >=10 digits) never reaches the
// store/embedding — while non-PII numerics (year ranges, metrics) and the other fields survive
// untouched. These cases lock both the redact AND the preserve sides. Ports the PII half of
// scripts/test-userid.ts, with the patterns expressed as an it.each truth-table.

describe("scrubProfilePii", () => {
  // Each row: a summary fragment, and whether scrubbing should remove it.
  it.each([
    { label: "email address", text: "reach me at jane.doe@example.com", redacted: true },
    { label: "10-digit phone with separators", text: "call (682) 333-9323 anytime", redacted: true },
    { label: "9-digit run (one below the phone threshold)", text: "ticket 12345-6789 open", redacted: false },
    { label: "year range (8 digits)", text: "Worked 2015-2019 on payments", redacted: false },
    { label: "a metric like p99", text: "tuned p99 latency", redacted: false },
  ])("$label → redacted=$redacted", ({ text, redacted }) => {
    const out = scrubProfilePii({ summary: text, skills: [], targetRoles: [] }).summary;
    expect(out.includes("[redacted]")).toBe(redacted);
  });

  it("redacts email + phone from a mixed summary but keeps a year range", () => {
    const scrubbed = scrubProfilePii({
      summary: "Senior engineer; reach me at jane.doe@example.com or (682) 333-9323. Worked 2015-2019.",
      skills: ["Go", "PostgreSQL"],
      targetRoles: ["Staff Engineer"],
    });
    expect(scrubbed.summary).not.toMatch(/@example\.com/);
    expect(scrubbed.summary).not.toMatch(/333-9323/);
    expect(scrubbed.summary).toMatch(/2015-2019/);
  });

  it("preserves non-PII skills and target-roles fields", () => {
    const scrubbed = scrubProfilePii({
      summary: "Senior engineer.",
      skills: ["Go", "PostgreSQL"],
      targetRoles: ["Staff Engineer"],
    });
    expect(scrubbed.skills).toEqual(["Go", "PostgreSQL"]);
    expect(scrubbed.targetRoles).toEqual(["Staff Engineer"]);
  });

  it("drops a field entry that collapses to empty after scrubbing", () => {
    const scrubbed = scrubProfilePii({
      summary: "",
      skills: ["   ", "Go"],
      targetRoles: [],
    });
    // The whitespace-only entry trims to "" and is filtered out; a bare email would survive as
    // "[redacted]" (non-empty), so only truly-empty entries drop.
    expect(scrubbed.skills).toEqual(["Go"]);
  });
});
