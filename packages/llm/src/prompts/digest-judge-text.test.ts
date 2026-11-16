import type { StructuredProfile } from "@opusfinder/shared";
import { describe, expect, it, vi } from "vitest";

import { JUDGE_ONLY_LINE } from "@test/profile-text-variants";

import { buildDigestSystem, DIGEST_SYNTHESIS_SYSTEM } from "./digest";

// The notes read the judge's text of the profile, not the embedded one. Here the two profile texts
// are made to differ (each gains a line of its own), and the system prompt must carry the judge's
// variant with no trace of the embedded one: a change to what is embedded never moves this prompt.
vi.mock("@opusfinder/shared", async (importOriginal) => {
  const { withDivergedProfileTexts } = await import("@test/profile-text-variants");
  return withDivergedProfileTexts(await importOriginal<typeof import("@opusfinder/shared")>());
});

const PROFILE: StructuredProfile = {
  summary: "Registered nurse with 8 years in acute medical-surgical care.",
  skills: ["Patient assessment", "IV therapy", "Epic"],
  targetRoles: ["Charge Nurse", "Clinical Nurse Educator"],
};

describe("buildDigestSystem — which profile text it reads", () => {
  it("renders the judge's text, untouched by a change to the embedded text", () => {
    // Hand-written: the profile block as rendered today, then the line only the judge's variant adds.
    expect(buildDigestSystem(PROFILE)).toBe(
      `${DIGEST_SYNTHESIS_SYSTEM}\n\n` +
        "=== Candidate profile ===\n" +
        "Registered nurse with 8 years in acute medical-surgical care.\n\n" +
        "Skills: Patient assessment, IV therapy, Epic\n\n" +
        "Target roles: Charge Nurse, Clinical Nurse Educator\n\n" +
        JUDGE_ONLY_LINE,
    );
  });
});
