import { describe, expect, it } from "vitest";

import { inferRemoteFromText, joinParts, nextOffset } from "./fields";

// Built at runtime so the fixture carries a real U+00A0 byte (no literal-escape ambiguity in source).
const NBSP = String.fromCharCode(0xa0);

// Leaf pure-unit (no workspace deps). These two helpers encode the location/remote INVARIANTS
// every ATS adapter shares, so a regression here silently corrupts `locations` + the `remote`
// flag across every source. Locks: joinParts drops non-string/blank parts and trims survivors
// (but does NOT dedupe), and inferRemoteFromText matches only the whole word "remote"
// (word-boundary, case-insensitive) so "remotely" and the empty case stay false, and never a
// negated or hybrid-qualified "remote" (Hybrid resolves to false per the NormalizedJob contract).
describe("joinParts", () => {
  it.each([
    { name: "all valid", parts: ["Austin", "TX", "USA"], expected: "Austin, TX, USA" },
    { name: "trims surrounding whitespace", parts: ["  Austin  ", " TX "], expected: "Austin, TX" },
    { name: "drops null", parts: ["Austin", null, "USA"], expected: "Austin, USA" },
    { name: "drops undefined", parts: ["Austin", undefined, "USA"], expected: "Austin, USA" },
    { name: "drops empty string", parts: ["Austin", "", "USA"], expected: "Austin, USA" },
    { name: "drops whitespace-only string", parts: ["Austin", "   ", "USA"], expected: "Austin, USA" },
    { name: "drops unicode NBSP-only string", parts: ["Austin", NBSP + NBSP, "USA"], expected: "Austin, USA" },
    { name: "drops non-string scalars", parts: ["Austin", 42, true, "USA"], expected: "Austin, USA" },
    { name: "drops nested arrays/objects", parts: [["x"], { a: 1 }, "USA"], expected: "USA" },
    { name: "single survivor → no separator", parts: [null, "Austin", ""], expected: "Austin" },
    { name: "empty input → empty string", parts: [], expected: "" },
    { name: "all blank/invalid → empty string", parts: [null, undefined, "", "  "], expected: "" },
    { name: "preserves duplicates (no dedupe)", parts: ["Remote", "Remote"], expected: "Remote, Remote" },
    { name: "keeps internal whitespace", parts: ["New York"], expected: "New York" },
  ])("$name", ({ parts, expected }) => {
    expect(joinParts(parts as unknown[])).toBe(expected);
  });
});

describe("inferRemoteFromText", () => {
  it.each([
    { name: "lowercase word", locations: ["remote"] },
    { name: "capitalized word", locations: ["Remote"] },
    { name: "uppercase word", locations: ["REMOTE"] },
    { name: "embedded in phrase", locations: ["100% Remote"] },
    { name: "punctuation boundary", locations: ["Remote, US"] },
    { name: "parenthetical", locations: ["Austin, TX (Remote)"] },
    { name: "hyphen is a word boundary", locations: ["Remote-first"] },
    { name: "match in a later element", locations: ["Austin", "Fully remote"] },
    { name: "remote offered beside hybrid", locations: ["Remote or Hybrid - NYC"] },
    { name: "comma-listed options", locations: ["Remote, Hybrid or On-site"] },
    { name: "a hybrid location doesn't cancel a remote one", locations: ["New York (Hybrid)", "Remote - US"] },
  ])("true: $name", ({ locations }) => {
    expect(inferRemoteFromText(locations)).toBe(true);
  });

  it.each([
    { name: "empty array", locations: [] as string[] },
    { name: "single empty string", locations: [""] },
    { name: "onsite location", locations: ["Austin, TX"] },
    { name: "hybrid only", locations: ["Hybrid"] },
    { name: "substring false-positive 'remotely'", locations: ["Works remotely sometimes"] },
    { name: "substring false-positive 'remoteness'", locations: ["remoteness"] },
    { name: "substring false-positive 'unremote'", locations: ["unremote"] },
    { name: "telecommute synonym not matched", locations: ["Telecommute"] },
    { name: "hybrid remote", locations: ["Hybrid Remote - New York, NY"] },
    { name: "hybrid, remote N days", locations: ["New York, NY (Hybrid, remote 2 days/week)"] },
    { name: "remote (hybrid)", locations: ["Remote (Hybrid)"] },
    { name: "remote - hybrid", locations: ["Remote - Hybrid, Berlin"] },
    { name: "non-remote", locations: ["Austin, TX - Non-Remote"] },
    { name: "not remote", locations: ["Chicago (not remote)"] },
    { name: "no remote", locations: ["Paris - no remote"] },
  ])("false: $name", ({ locations }) => {
    expect(inferRemoteFromText(locations)).toBe(false);
  });
});

describe("nextOffset", () => {
  const at = (offset: number) => ({ kind: "offset" as const, offset });

  it.each([
    { name: "first page below the total advances by the page size", total: 300, prev: null, count: 100, next: at(100) },
    { name: "advances by the ACTUAL count (a server-clamped page)", total: 300, prev: at(100), count: 50, next: at(150) },
    { name: "stops once the window covers the total", total: 300, prev: at(200), count: 100, next: null },
    { name: "an empty page stops, even short of the total", total: 300, prev: at(100), count: 0, next: null },
    { name: "no total: a full page continues", total: undefined, prev: at(100), count: 100, next: at(200) },
    { name: "no total: a short page stops", total: undefined, prev: at(100), count: 37, next: null },
  ])("$name", ({ total, prev, count, next }) => {
    expect(nextOffset(total, prev, count, 100)).toEqual(next);
  });
});
