import { describe, expect, it } from "vitest";

import { companySlug, jobId, safeJobId } from "./index";

// Leaf pure-unit for the id/slug branding floor. `jobId` is the STRICT constructor (throws on a bad id);
// `safeJobId` is its non-throwing sibling that a `SourceAdapter.mapItem` uses to honor the "skip + count,
// never throw on bad data" contract. The load-bearing invariant: safeJobId accepts EXACTLY what jobId
// accepts and returns null for everything jobId would reject — interior whitespace included (the case the
// adapters' old `trim().length === 0` guard missed, which let a single malformed posting id throw out of
// the whole page loop). `companySlug` enforces the URL-path-safe slug floor (no whitespace, no `/`).

describe("jobId — strict branded constructor", () => {
  it.each([
    ["abc", "abc"],
    ["  abc  ", "abc"], // surrounding whitespace is trimmed
    ["123", "123"],
    ["a-uuid_v4.0", "a-uuid_v4.0"],
  ])("%j → %j", (input, expected) => {
    expect(jobId(input)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["   ", "whitespace-only"],
    ["a b", "interior space"],
    ["a\tb", "interior tab"],
    ["a\nb", "interior newline"],
  ])("throws on %j (%s)", (input) => {
    expect(() => jobId(input)).toThrow(/Invalid JobId/);
  });
});

describe("safeJobId — non-throwing jobId (skip on bad data)", () => {
  it.each([
    ["abc", "abc"],
    ["  abc  ", "abc"], // trimmed, same as jobId
    ["opaque-token_42", "opaque-token_42"],
  ])("%j → branded %j", (input, expected) => {
    expect(safeJobId(input)).toBe(expected);
  });

  it.each([
    ["a b", "interior space — the adapter bug case"],
    ["job 123", "interior space"],
    ["a\tb", "interior tab"],
    ["line\nbreak", "interior newline"],
    ["", "empty"],
    ["   ", "whitespace-only"],
  ])("returns null for %j (%s) — never throws", (input) => {
    expect(safeJobId(input)).toBeNull();
  });

  it.each<[unknown, string]>([
    [42, "number"],
    [null, "null"],
    [undefined, "undefined"],
    [{}, "object"],
    [["a"], "array"],
    [true, "boolean"],
  ])("returns null for non-string %s", (input) => {
    expect(safeJobId(input)).toBeNull();
  });

  it("never throws on any input jobId would reject (delegation parity)", () => {
    for (const bad of ["a b", "", "   ", "x\ty", 7, null, undefined, {}]) {
      expect(() => safeJobId(bad)).not.toThrow();
    }
  });
});

describe("companySlug — URL-path-safe slug floor", () => {
  it.each([
    ["acme-corp", "acme-corp"],
    ["  acme  ", "acme"], // trimmed
    ["SmartRecruitersInc", "SmartRecruitersInc"], // case preserved (case-sensitive lookups)
    ["a_b.c-1", "a_b.c-1"],
  ])("%j → %j", (input, expected) => {
    expect(companySlug(input)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["a b", "interior space"],
    ["a/b", "path separator — injection guard"],
    ["café", "non-ASCII"],
    ["a:b", "colon"],
  ])("throws on %j (%s)", (input) => {
    expect(() => companySlug(input)).toThrow(/Invalid CompanySlug/);
  });
});
