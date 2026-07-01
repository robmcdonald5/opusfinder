import { describe, expect, it } from "vitest";

import type { LocationMode } from "@opusfinder/shared";

import { geoMatches } from "./retrieval";

// Leaf pure-unit for the ONE deterministic retrieval filter shipped now (salary/YoE are stored +
// soft-prompt only). Ports scripts/test-location-mode.ts — a wrong branch silently drops or keeps the
// wrong jobs. Fixtures copied VERBATIM from the smoke. `locationOverlaps` is private, so its boundary
// (>=4-char containment vs <4-char exact-only) is exercised through geoMatches's on-site location path.

const REMOTE = { remote: true, locations: [] as string[] };
const ONSITE_SF = { remote: false, locations: ["San Francisco, CA"] };
const ONSITE_UNKNOWN = { remote: false, locations: [] as string[] }; // ATS left location empty
const SF = ["San Francisco"];

describe("geoMatches — location-mode truth table", () => {
  // 1) A REMOTE job: kept under 'any'/'remote_only', DROPPED under 'onsite_only'. The locations list is
  //    irrelevant for a remote job (so 'remote_only' with [] still passes).
  describe("remote job (locations ignored)", () => {
    it.each<[LocationMode, string[], boolean]>([
      ["any", SF, true],
      ["remote_only", SF, true],
      ["onsite_only", SF, false],
      ["remote_only", [], true],
    ])("mode=%s locations=%j -> %s", (mode, locations, expected) => {
      expect(geoMatches(REMOTE, mode, locations)).toBe(expected);
    });
  });

  // 2) An ON-SITE job with an allowlist: DROPPED under 'remote_only'; under 'any'/'onsite_only' it honors
  //    the locations allowlist (overlap → keep; no overlap → drop).
  describe("on-site job with allowlist [San Francisco]", () => {
    it.each<[LocationMode, string[], boolean]>([
      ["remote_only", SF, false],
      ["any", SF, true],
      ["onsite_only", SF, true],
      ["onsite_only", ["New York"], false],
    ])("mode=%s locations=%j -> %s", (mode, locations, expected) => {
      expect(geoMatches(ONSITE_SF, mode, locations)).toBe(expected);
    });
  });

  // 3) No location CONSTRAINT (empty user locations): an on-site job passes under 'any'/'onsite_only'.
  describe("on-site job with EMPTY user locations (no constraint)", () => {
    it.each<[LocationMode, boolean]>([
      ["any", true],
      ["onsite_only", true],
    ])("mode=%s -> %s", (mode, expected) => {
      expect(geoMatches(ONSITE_SF, mode, [])).toBe(expected);
    });
  });

  // 4) Unknown-location-passes (recall guard): a job with NO location data is kept under 'any'/'onsite_only'
  //    even with a location constraint set — unknown ≠ mismatch.
  describe("unknown-location on-site job passes DESPITE a constraint (unknown != mismatch)", () => {
    it.each<[LocationMode, boolean]>([
      ["any", true],
      ["onsite_only", true],
    ])("mode=%s locations=SF -> %s", (mode, expected) => {
      expect(geoMatches(ONSITE_UNKNOWN, mode, SF)).toBe(expected);
    });
  });

  // 5) Invariant: for an on-site job the 'any' and 'onsite_only' paths are identical (RHS not hardcoded —
  //    both branches fall through to the same locations rule once the remote/remote_only guards are past).
  it("on-site path is identical for 'any' and 'onsite_only'", () => {
    expect(geoMatches(ONSITE_SF, "any", SF)).toBe(geoMatches(ONSITE_SF, "onsite_only", SF));
  });

  // Legacy boolean mapping preserved: remote_ok=true ≡ 'any' (remote kept); remote_ok=false ≡ 'onsite_only'
  // (remote dropped).
  describe("legacy remote_ok mapping preserved", () => {
    it("'any' ≡ remote_ok=true: remote job kept", () => {
      expect(geoMatches(REMOTE, "any", SF)).toBe(true);
    });
    it("'onsite_only' ≡ remote_ok=false: remote job dropped", () => {
      expect(geoMatches(REMOTE, "onsite_only", SF)).toBe(false);
    });
  });

  // locationOverlaps boundary (private → driven via the on-site 'onsite_only' location path):
  //   - a >=4-char token matches by CONTAINMENT in BOTH directions;
  //   - a <4-char token ('ca'/'CA') matches ONLY exactly (case-folded) and must NOT substring-match inside
  //     a longer location — "chicago" contains "ca", but the <4-char guard blocks the false positive.
  describe("locationOverlaps boundary via on-site match", () => {
    it(">=4-char token: job superset contains user subset ('san francisco, ca' ⊇ 'san francisco')", () => {
      expect(
        geoMatches({ remote: false, locations: ["San Francisco, CA"] }, "onsite_only", ["San Francisco"]),
      ).toBe(true);
    });

    it(">=4-char token: user superset contains job subset ('san francisco' ⊆ 'san francisco, ca')", () => {
      expect(
        geoMatches({ remote: false, locations: ["San Francisco"] }, "onsite_only", ["San Francisco, CA"]),
      ).toBe(true);
    });

    // Same-CASE exact hit only (both sides 'CA'): this proves the exact-match branch, but does NOT force
    // case-folding — the case-forcing pair below does that.
    it("<4-char token 'CA' matches exactly (same case)", () => {
      expect(geoMatches({ remote: false, locations: ["CA"] }, "onsite_only", ["CA"])).toBe(true);
    });

    // Case-forcing: job & user differ ONLY in case, so a green result PROVES geoMatches lower-cases both
    // sides (retrieval.ts:227 & :229). Delete either .toLowerCase() and both of these flip to false.
    it("<4-char token is case-folded: job 'ca' matches user 'CA' (exact-only, differing case)", () => {
      expect(geoMatches({ remote: false, locations: ["ca"] }, "onsite_only", ["CA"])).toBe(true);
    });

    it(">=4-char CONTAINMENT is case-folded: 'san francisco, CA' ⊇ 'San Francisco'", () => {
      expect(
        geoMatches({ remote: false, locations: ["san francisco, CA"] }, "onsite_only", ["San Francisco"]),
      ).toBe(true);
    });

    // b-side short-token guard (retrieval.ts:239): a <4-char USER token must NOT substring-match inside a
    // longer JOB location — "chicago" contains "ca", but `b.length >= 4` blocks the false positive.
    it("<4-char USER token 'CA' does NOT substring-match inside a longer JOB location ('chicago')", () => {
      expect(geoMatches({ remote: false, locations: ["Chicago"] }, "onsite_only", ["CA"])).toBe(false);
    });

    // a-side short-token guard (retrieval.ts:240), the MIRROR of the above: a <4-char JOB token must NOT
    // substring-match inside a longer USER location — `a.length >= 4` blocks it.
    it("<4-char JOB token 'CA' does NOT substring-match inside a longer USER location ('chicago')", () => {
      expect(geoMatches({ remote: false, locations: ["CA"] }, "onsite_only", ["Chicago"])).toBe(false);
    });
  });
});
