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

  // Hand-written, never computed through the shared composer, so a change to what the notes read
  // cannot rewrite the expectation along with the behaviour.
  it("renders the rubric, the profile block, then the preferences block for a fixed profile", () => {
    const profile: StructuredProfile = {
      summary: "Registered nurse with 8 years in acute medical-surgical care.",
      skills: ["Patient assessment", "IV therapy", "Epic"],
      targetRoles: ["Charge Nurse", "Clinical Nurse Educator"],
      facts: {
        credentials: [
          {
            name: "Registered Nurse",
            issuer: "Texas Board of Nursing",
            status: "active",
            expires: "2027-03",
          },
        ],
        education: [{ level: "bachelor", field: "Nursing", completed: true }],
        yearsExperience: { total: 8, byRoleFamily: [{ roleFamily: "Nursing", years: 8 }] },
        languages: [{ language: "Spanish", proficiency: "conversational" }],
        workAuthorization: "Authorized to work in the US",
      },
      extractVersion: 2,
    };
    const profileBlock =
      "=== Candidate profile ===\n" +
      "Registered nurse with 8 years in acute medical-surgical care.\n\n" +
      "Skills: Patient assessment, IV therapy, Epic\n\n" +
      "Target roles: Charge Nurse, Clinical Nurse Educator";

    expect(buildDigestSystem(profile)).toBe(`${DIGEST_SYNTHESIS_SYSTEM}\n\n${profileBlock}`);
    expect(
      buildDigestSystem(profile, {
        yoeMin: 5,
        yoeMax: null,
        minSalary: null,
        maxSalary: 110000,
        dealbreakers: ["night shifts"],
      }),
    ).toBe(
      `${DIGEST_SYNTHESIS_SYSTEM}\n\n${profileBlock}\n\n` +
        "=== Candidate stated preferences ===\n" +
        "Target years of experience: at least 5\n" +
        "Salary preference: up to 110000\n" +
        "Dealbreakers (avoid): night shifts",
    );
  });
});
