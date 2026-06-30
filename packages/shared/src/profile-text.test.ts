import { describe, expect, it } from "vitest";

import { composeProfileText } from "./index";

// Golden-vector contract for the embedding "query" text composition. composeProfileText is the single
// source of truth for what goes in the profile vector, so its label format + ordering + blank-dropping
// are load-bearing: drift silently changes every embedded profile and corrupts retrieval. Pins the
// frozen vector and the "no embeddable content" (empty iff all-blank) boundary. Ports the
// profile-text half of scripts/test-userid.ts.

// FROZEN. composeProfileText output for the canonical profile below.
const GOLDEN_PROFILE_TEXT = "Senior backend engineer.\n\nSkills: Go, Postgres\n\nTarget roles: Staff Engineer";

describe("composeProfileText", () => {
  it("pins the golden vector — label format, ordering, and blank-line join", () => {
    const text = composeProfileText({
      summary: "Senior backend engineer.",
      skills: ["Go", "Postgres"],
      targetRoles: ["Staff Engineer"],
    });
    expect(text).toBe(GOLDEN_PROFILE_TEXT);
  });

  it("is empty when every field is blank (the 'no embeddable content' boundary)", () => {
    expect(composeProfileText({ summary: "", skills: [], targetRoles: [] })).toBe("");
  });

  it("drops the skills label when skills are empty", () => {
    const text = composeProfileText({
      summary: "Senior backend engineer.",
      skills: [],
      targetRoles: ["Staff Engineer"],
    });
    expect(text).toBe("Senior backend engineer.\n\nTarget roles: Staff Engineer");
  });

  it("drops the target-roles label when target roles are empty", () => {
    const text = composeProfileText({
      summary: "Senior backend engineer.",
      skills: ["Go", "Postgres"],
      targetRoles: [],
    });
    expect(text).toBe("Senior backend engineer.\n\nSkills: Go, Postgres");
  });

  it("drops a whitespace-only summary but keeps the labeled context", () => {
    const text = composeProfileText({
      summary: "   ",
      skills: ["Go"],
      targetRoles: ["Staff Engineer"],
    });
    expect(text).toBe("Skills: Go\n\nTarget roles: Staff Engineer");
  });
});
