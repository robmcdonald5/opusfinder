import { describe, expect, it } from "vitest";

import { inferRemoteFromText, joinParts } from "./fields";

// Built at runtime so the fixture carries a real U+00A0 byte (no literal-escape ambiguity in source).
const NBSP = String.fromCharCode(0xa0);

// Leaf pure-unit (no workspace deps). These two helpers encode the location/remote INVARIANTS
// every ATS adapter shares, so a regression here silently corrupts `locations` + the `remote`
// flag across all five sources. Locks: joinParts drops non-string/blank parts and trims survivors
// (but does NOT dedupe), and inferRemoteFromText matches only the whole word "remote"
// (word-boundary, case-insensitive) so "remotely" and the empty case stay false.
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
  ])("false: $name", ({ locations }) => {
    expect(inferRemoteFromText(locations)).toBe(false);
  });
});
