import { describe, expect, it } from "vitest";

import { profileExtractVersion, scrubProfilePii, type CvFacts } from "./index";

// Defense-in-depth PII scrub contract. The profile is persisted + vectorized, so scrubProfilePii is
// the last guard that machine-detectable PII (emails + phone runs of >=10 digits) never reaches the
// store/embedding — while non-PII numerics (year ranges, metrics) and the other fields survive
// untouched. These cases lock both the redact AND the preserve sides. Ports the PII half of
// scripts/test-userid.ts, with the patterns expressed as an it.each truth-table.

describe("scrubProfilePii", () => {
  // Each row: a summary fragment, and whether scrubbing should remove it.
  it.each([
    { label: "email address", text: "reach me at jane.doe@example.com", redacted: true, expected: "reach me at [redacted]" },
    { label: "10-digit phone with separators", text: "call (682) 333-9323 anytime", redacted: true, expected: "call [redacted] anytime" },
    { label: "phone with non-breaking hyphens (U+2011)", text: "call 682\u2011333\u20119323", redacted: true, expected: "call [redacted]" },
    { label: "phone with en dashes (U+2013)", text: "call 682\u2013333\u20139323 anytime", redacted: true, expected: "call [redacted] anytime" },
    { label: "phone with minus signs (U+2212)", text: "call +1 682\u2212333\u22129323", redacted: true, expected: "call [redacted]" },
    { label: "9-digit run (one below the phone threshold)", text: "ticket 12345-6789 open", redacted: false, expected: "ticket 12345-6789 open" },
    { label: "year range (8 digits)", text: "Worked 2015-2019 on payments", redacted: false, expected: "Worked 2015-2019 on payments" },
    { label: "back-to-back year ranges (>=10 digits, all years)", text: "Led 2015-2019 2019-2023 migrations", redacted: false, expected: "Led 2015-2019 2019-2023 migrations" },
    { label: "a metric like p99", text: "tuned p99 latency", redacted: false, expected: "tuned p99 latency" },
  ])("$label → redacted=$redacted", ({ text, redacted, expected }) => {
    const out = scrubProfilePii({ summary: text, skills: [], targetRoles: [] }).summary;
    // Pin the EXACT scrubbed string: redact placement AND byte-for-byte survival of the non-PII text.
    expect(out).toBe(expected);
    expect(out.includes("[redacted]")).toBe(redacted);
  });

  it("redacts email + phone from a mixed summary but keeps a year range", () => {
    const scrubbed = scrubProfilePii({
      summary: "Senior engineer; reach me at jane.doe@example.com or (682) 333-9323. Worked 2015-2019.",
      skills: ["Go", "PostgreSQL"],
      targetRoles: ["Staff Engineer"],
    });
    // Deterministic scrub → pin the whole composed output: both redactions placed, spacing intact, year kept.
    expect(scrubbed.summary).toBe("Senior engineer; reach me at [redacted] or [redacted]. Worked 2015-2019.");
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

  it("scrubs the facts' text and carries the rest, version included, through unchanged", () => {
    const facts: CvFacts = {
      credentials: [
        {
          name: "Registered Nurse (RN), licence 8489110042",
          issuer: "ask rn@board.example",
          status: "active",
          expires: "2027-03",
        },
      ],
      education: [{ level: "bachelor", field: "Nursing", completed: true }],
      yearsExperience: { total: 14, byRoleFamily: [{ roleFamily: "charge nursing", years: 7 }] },
      languages: [{ language: "Spanish", proficiency: null }],
      workAuthorization: "Authorized to work in the US, call 682-333-9323",
    };
    const scrubbed = scrubProfilePii({
      summary: "Nurse.",
      skills: [],
      targetRoles: [],
      facts,
      extractVersion: 2,
    });
    expect(scrubbed).toEqual({
      summary: "Nurse.",
      skills: [],
      targetRoles: [],
      facts: {
        ...facts,
        credentials: [
          {
            name: "Registered Nurse (RN), licence [redacted]",
            issuer: "ask [redacted]",
            status: "active",
            expires: "2027-03",
          },
        ],
        workAuthorization: "Authorized to work in the US, call [redacted]",
      },
      extractVersion: 2,
    });
  });

  it("adds neither facts nor a version to a profile that has none", () => {
    const scrubbed = scrubProfilePii({ summary: "Engineer.", skills: [], targetRoles: [] });
    expect(Object.keys(scrubbed)).toEqual(["summary", "skills", "targetRoles"]);
  });
});

describe("profileExtractVersion", () => {
  it("reads a profile stored before the tag existed as version 1", () => {
    expect(profileExtractVersion({})).toBe(1);
    expect(profileExtractVersion({ extractVersion: 2 })).toBe(2);
  });
});
