import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CvFacts, StructuredProfile } from "@opusfinder/shared";

import {
  credentialsMentioned,
  CV_GROUPS,
  loadCvKeys,
  scoreProfile,
  summarize,
  type CvKey,
  type ScoredField,
} from "./cv-extract-key";
import { loadCvRegistry } from "./profile-set";
import { PKG_ROOT } from "./runner";

const KEY: CvKey = {
  id: "nurse",
  group: "healthcare-licensed",
  source: { dataset: "d", revision: "0".repeat(40), path: "p.pdf", sha256: "0".repeat(64) },
  expected: {
    summary: [["nurse", "nursing"]],
    skills: [["wound care"], ["iv", "intravenous"]],
    targetRoles: ["nurse", "rn"],
    credentials: [
      { match: ["registered nurse", "rn"], status: null, expires: "2016-12" },
      { match: ["bls"], issuer: ["red cross"], status: null, expires: null },
      { match: ["cna"], status: "any", expires: "any", optional: true },
    ],
    education: [
      { level: ["bachelor"], field: ["nursing"], completed: true },
      { level: ["certificate", "other"], completed: "any", optional: true },
    ],
    years: [{ years: 14, slot: "either" }],
    languages: [{ match: ["spanish"] }],
    workAuthorization: ["authorized to work in the us"],
    forbidden: ["848911"],
  },
  judgementCalls: [],
};

const FACTS: CvFacts = {
  credentials: [
    { name: "Registered Nurse (RN)", issuer: null, status: null, expires: "12/2016" },
    { name: "BLS", issuer: "American Red Cross", status: null, expires: null },
  ],
  education: [{ level: "bachelor", field: "Nursing", completed: true }],
  yearsExperience: { total: 14, byRoleFamily: [] },
  languages: [{ language: "Spanish", proficiency: "fluent" }],
  workAuthorization: "Authorized to work in the US for any employer",
};

const PROFILE: StructuredProfile = {
  summary: "Registered nurse with 14 years in medical-surgical care.",
  skills: ["Wound care", "IV therapy"],
  targetRoles: ["Registered Nurse"],
  facts: FACTS,
  extractVersion: 2,
};

const withFacts = (facts: Partial<CvFacts>): StructuredProfile => ({
  ...PROFILE,
  facts: { ...FACTS, ...facts },
});

function wrong(
  profile: StructuredProfile,
  key: CvKey = KEY,
): Partial<Record<ScoredField, string[]>> {
  return Object.fromEntries(
    scoreProfile(profile, key)
      .filter((r) => !r.correct)
      .map((r) => [r.field, r.problems]),
  );
}

describe("scoreProfile", () => {
  it("passes every field of a profile that matches its key", () => {
    expect(wrong(PROFILE)).toEqual({});
    expect(scoreProfile(PROFILE, KEY)).toHaveLength(9);
  });

  it("matches aliases as whole words, whatever the case and punctuation", () => {
    // "intern" must not satisfy "rn", nor "naive" satisfy "iv".
    const profile = {
      ...PROFILE,
      targetRoles: ["Nursing Intern"],
      skills: ["wound-care", "Naive Bayes"],
    };
    expect(wrong({ ...profile, summary: "Nursing student." })).toEqual({
      skills: ["nothing matches: iv / intravenous"],
      targetRoles: ['first role "Nursing Intern" is none of: nurse, rn'],
    });
  });

  it("fails a list field on a missing entry and on one the key does not allow", () => {
    expect(wrong(withFacts({ credentials: [FACTS.credentials[0]!] })).credentials).toEqual([
      "missing: bls",
    ]);
    const extra = { name: "ACLS", issuer: null, status: null, expires: null };
    expect(wrong(withFacts({ credentials: [...FACTS.credentials, extra] })).credentials).toEqual([
      "unexpected: ACLS",
    ]);
  });

  it("lets an optional entry appear any number of times, unchecked", () => {
    const cna = { name: "CNA", issuer: "State", status: "inactive" as const, expires: "2009" };
    expect(wrong(withFacts({ credentials: [...FACTS.credentials, cna, cna] }))).toEqual({});
    const course = { level: "certificate" as const, field: "Phlebotomy", completed: false };
    expect(wrong(withFacts({ education: [...FACTS.education, course] }))).toEqual({});
  });

  it("checks a matched credential's status, expiry and issuer", () => {
    const [rn, bls] = FACTS.credentials;
    const credentials = [
      { ...rn!, status: "active" as const, expires: "2017" },
      { ...bls!, issuer: null },
    ];
    expect(wrong(withFacts({ credentials })).credentials).toEqual([
      "Registered Nurse (RN): status active ≠ null",
      "Registered Nurse (RN): expires 2017 ≠ 2016-12",
      "BLS: issuer null ≠ red cross",
    ]);
  });

  it("gives each required entry its own item when one item could fill two", () => {
    const cert = (name: string) => ({ name, issuer: null, status: null, expires: null });
    const key: CvKey = {
      ...KEY,
      expected: {
        ...KEY.expected,
        // "network" also matches the CCNA's long name; only a real matching pairs both.
        credentials: [
          { match: ["network"], status: null, expires: null },
          { match: ["ccna"], status: null, expires: null },
        ],
      },
    };
    const credentials = [
      cert("CCNA (Cisco Certified Network Associate)"),
      cert("CompTIA Network+"),
    ];
    expect(wrong(withFacts({ credentials }), key).credentials).toBeUndefined();
    expect(wrong(withFacts({ credentials: [credentials[0]!] }), key).credentials).toHaveLength(1);
  });

  it("accepts a stated figure in either slot within rounding, and nothing else", () => {
    const family = { total: null, byRoleFamily: [{ roleFamily: "nursing", years: 14.5 }] };
    expect(wrong(withFacts({ yearsExperience: family }))).toEqual({});
    expect(
      wrong(withFacts({ yearsExperience: { total: 12, byRoleFamily: [] } })).yearsExperience,
    ).toEqual(["missing: 14 (either)", "unexpected: 12 (total)"]);
  });

  it("fails an education entry that says unfinished where the key says finished", () => {
    const education = [{ level: "bachelor" as const, field: "Nursing", completed: false }];
    expect(wrong(withFacts({ education })).education).toEqual([
      "bachelor Nursing: completed false ≠ true",
    ]);
  });

  it("requires silence where the CV is silent", () => {
    const silent: CvKey = {
      ...KEY,
      expected: { ...KEY.expected, workAuthorization: null, languages: [] },
    };
    expect(wrong(PROFILE, silent)).toEqual({
      languages: ["unexpected: Spanish"],
      workAuthorization: [
        '"Authorized to work in the US for any employer" but the CV makes no statement',
      ],
    });
    expect(wrong(withFacts({ workAuthorization: null, languages: [] }), silent)).toEqual({});
  });

  it("fails `protected` when a forbidden term appears anywhere, and skips it when the key lists none", () => {
    const leaked = withFacts({
      credentials: [{ ...FACTS.credentials[0]!, name: "RN #848911" }, FACTS.credentials[1]!],
    });
    expect(wrong(leaked).protected).toEqual(['contains "848911"']);
    const noTerms: CvKey = { ...KEY, expected: { ...KEY.expected, forbidden: [] } };
    expect(scoreProfile(PROFILE, noTerms).map((r) => r.field)).not.toContain("protected");
  });

  it("scores a version-1 profile, which has no facts, as stating none", () => {
    const { facts: _facts, extractVersion: _version, ...v1 } = PROFILE;
    expect(Object.keys(wrong(v1))).toEqual([
      "credentials",
      "education",
      "yearsExperience",
      "languages",
      "workAuthorization",
    ]);
  });
});

describe("summarize", () => {
  it("splits the totals by field kind and group, and counts credentials named in the embedded text", () => {
    const { facts: _facts, ...v1 } = { ...PROFILE, skills: [...PROFILE.skills, "BLS"] };
    const summary = summarize([{ key: KEY, profile: v1, results: scoreProfile(v1, KEY) }]);
    expect(summary.overall).toEqual({ correct: 4, total: 9 });
    expect(summary.sharedFields).toEqual({ correct: 4, total: 4 });
    expect(summary.factFields).toEqual({ correct: 0, total: 5 });
    expect(summary.tuned).toEqual({ correct: 4, total: 9 });
    expect(summary.heldOut).toEqual({ correct: 0, total: 0 });
    const heldOut = { ...KEY, heldOut: true as const };
    expect(
      summarize([{ key: heldOut, profile: v1, results: scoreProfile(v1, heldOut) }]).heldOut,
    ).toEqual({ correct: 4, total: 9 });
    expect(summary.byGroup["healthcare-licensed"]).toEqual({ correct: 4, total: 9 });
    expect(summary.byGroup.tech).toEqual({ correct: 0, total: 0 });
    // "Registered nurse" in the summary and "BLS" in the skills; the optional CNA is not counted.
    expect(credentialsMentioned(v1, KEY)).toEqual({ found: 2, of: 2 });
  });
});

describe("the committed keys", () => {
  const keys = loadCvKeys(join(PKG_ROOT, "data", "cv-extract", "keys"), loadCvRegistry());

  it("all parse, and cover every group", () => {
    expect(keys.length).toBeGreaterThanOrEqual(20);
    for (const group of CV_GROUPS) expect(keys.some((key) => key.group === group)).toBe(true);
  });

  it("include held-out CVs in every group but tech", () => {
    const heldOut = keys.filter((key) => key.heldOut);
    for (const group of CV_GROUPS.filter((g) => g !== "tech"))
      expect(heldOut.some((key) => key.group === group)).toBe(true);
  });
});
