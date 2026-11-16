import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { profileEmbedText, type StructuredProfile } from "@opusfinder/shared";

import {
  countByGroup,
  cvPdfPath,
  isSynthetic,
  loadCvRegistry,
  loadProfileSet,
  PROFILE_SET_VERSION,
  profileContentHash,
  SYNTHETIC_CVS_DIR,
  SYNTHETIC_LAYOUTS,
} from "./profile-set";

const PROFILE: StructuredProfile = {
  summary: "Line cook with fast-casual and catering experience.",
  skills: ["Food prep", "Sauté"],
  targetRoles: ["Line Cook"],
  facts: {
    credentials: [{ name: "ServSafe", issuer: null, status: null, expires: "2027" }],
    education: [],
    yearsExperience: { total: 6, byRoleFamily: [] },
    languages: [],
    workAuthorization: null,
  },
  extractVersion: 2,
};

describe("profileContentHash", () => {
  it("ignores key order and formatting", () => {
    const reordered = JSON.parse(
      JSON.stringify({
        extractVersion: 2,
        facts: PROFILE.facts,
        targetRoles: PROFILE.targetRoles,
        skills: PROFILE.skills,
        summary: PROFILE.summary,
      }),
    ) as StructuredProfile;
    expect(profileContentHash(reordered)).toBe(profileContentHash(PROFILE));
    expect(profileContentHash(PROFILE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with anything a judge or an embedder could read", () => {
    const base = profileContentHash(PROFILE);
    const variants: StructuredProfile[] = [
      { ...PROFILE, skills: ["Sauté", "Food prep"] },
      { ...PROFILE, targetRoles: ["Cook"] },
      { ...PROFILE, facts: { ...PROFILE.facts!, workAuthorization: "US citizen" } },
      { ...PROFILE, extractVersion: 3 },
    ];
    for (const variant of variants) expect(profileContentHash(variant)).not.toBe(base);
  });
});

describe("loadProfileSet", () => {
  const dir = mkdtempSync(join(tmpdir(), "profile-set-"));
  const cv = {
    id: "line-cook",
    group: "hourly-shift",
    source: { dataset: "d", revision: "0".repeat(40), path: "p.pdf", sha256: "0".repeat(64) },
  };
  writeFileSync(join(dir, "cvs.json"), JSON.stringify([cv]));
  mkdirSync(join(dir, "v2"));

  it("names the CVs that have no profile at the version", () => {
    expect(() => loadProfileSet(2, dir)).toThrow(/no version-2 profile for: line-cook/);
  });

  it("joins each CV with its profile and content hash, and rejects another version's file", () => {
    writeFileSync(join(dir, "v2", "line-cook.json"), JSON.stringify(PROFILE));
    expect(loadProfileSet(2, dir)).toEqual([
      { ...cv, profile: PROFILE, contentHash: profileContentHash(PROFILE) },
    ]);
    writeFileSync(
      join(dir, "v2", "line-cook.json"),
      JSON.stringify({ ...PROFILE, extractVersion: 3 }),
    );
    expect(() => loadProfileSet(2, dir)).toThrow(/tagged version 3, not 2/);
  });

  it("rejects a registry that lists an id twice", () => {
    writeFileSync(join(dir, "cvs.json"), JSON.stringify([cv, cv]));
    expect(() => loadCvRegistry(join(dir, "cvs.json"))).toThrow(/"line-cook" is listed twice/);
  });
});

describe("the committed profile set", () => {
  const profiles = loadProfileSet();

  it("has at least 48 profiles, 16 or more in each non-tech group, all at the set's version", () => {
    expect(profiles.length).toBeGreaterThanOrEqual(48);
    const counts = countByGroup(profiles);
    expect(counts["healthcare-licensed"]).toBeGreaterThanOrEqual(16);
    expect(counts["hourly-shift"]).toBeGreaterThanOrEqual(16);
    expect(counts["other-non-tech"]).toBeGreaterThanOrEqual(16);
    for (const { profile } of profiles) {
      expect(profile.extractVersion).toBe(PROFILE_SET_VERSION);
      expect(profile.facts).toBeDefined();
      expect(profileEmbedText(profile)).not.toBe("");
    }
  });

  it("gives every profile its own content hash", () => {
    expect(new Set(profiles.map((p) => p.contentHash)).size).toBe(profiles.length);
  });

  it("commits each synthetic CV as the pinned PDF with its HTML source, in every layout", () => {
    const synthetic = loadCvRegistry().filter((cv) => isSynthetic(cv.source));
    for (const cv of synthetic) {
      const sha256 = createHash("sha256")
        .update(readFileSync(cvPdfPath(cv)))
        .digest("hex");
      expect(sha256, cv.id).toBe(cv.source.sha256);
      expect(existsSync(join(SYNTHETIC_CVS_DIR, `${cv.id}.html`)), cv.id).toBe(true);
    }
    const layouts = new Set(synthetic.map((cv) => isSynthetic(cv.source) && cv.source.layout));
    for (const layout of SYNTHETIC_LAYOUTS) expect(layouts.has(layout)).toBe(true);
  });

  it("pins each dataset CV once", () => {
    const paths = loadCvRegistry().flatMap((cv) =>
      isSynthetic(cv.source) ? [] : [cv.source.path],
    );
    expect(new Set(paths).size).toBe(paths.length);
  });
});
