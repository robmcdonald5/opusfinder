import { describe, expect, it } from "vitest";

import { parseDatasetLines } from "./dataset";

// Leaf pure-unit (string-in → examples-out; no filesystem — loadDataset's readFileSync is the only
// I/O and is out of scope here). The validator is the boundary guard against hand-authoring
// mistakes, so the load-bearing cases are the ones that would otherwise SILENTLY corrupt scoring:
// an out-of-pool good id (caps recall < 1 forever), a duplicate candidate id (double-counts a hit,
// recall > 1), and a contentless job/profile (composes to "" and 400s the embedder). Ports the
// loader cases from scripts/test-metrics.ts to frozen inline JSONL fixtures.

// One well-formed example, kept as a builder so each case tweaks a single field off a valid base.
const VALID_LINE =
  '{"profile":{"id":"p1","summary":"s","skills":["Go"],"targetRoles":["Backend"]},' +
  '"candidateJobs":[{"id":1,"title":"t","descriptionText":"d"}],"expectedGoodIds":[1]}';

describe("parseDatasetLines", () => {
  it("parses a valid line and skips comment/blank lines", () => {
    const parsed = parseDatasetLines(`# header\n\n${VALID_LINE}`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.profile.id).toBe("p1");
    expect(parsed[0]?.expectedGoodIds).toEqual([1]);
  });

  it("skips // comment lines too", () => {
    expect(parseDatasetLines(`// note\n${VALID_LINE}`)).toHaveLength(1);
  });

  it.each([
    {
      label: "malformed JSON",
      line: '{"profile":',
      match: /invalid JSON/,
    },
    {
      label: "out-of-pool good id",
      line:
        '{"profile":{"id":"p1","summary":"s","skills":[],"targetRoles":[]},' +
        '"candidateJobs":[{"id":1,"title":"t","descriptionText":"d"}],"expectedGoodIds":[2]}',
      match: /expectedGoodIds contains 2, which is absent from candidateJobs\./,
    },
    {
      label: "non-integer good id (can never match an integer pool id)",
      line:
        '{"profile":{"id":"p1","summary":"s","skills":[],"targetRoles":[]},' +
        '"candidateJobs":[{"id":1,"title":"t","descriptionText":"d"}],"expectedGoodIds":[1.5]}',
      match: /only integers/,
    },
    {
      label: "duplicate candidate ids",
      line:
        '{"profile":{"id":"p1","summary":"s","skills":[],"targetRoles":[]},' +
        '"candidateJobs":[{"id":1,"title":"t","descriptionText":"d"},' +
        '{"id":1,"title":"u","descriptionText":"e"}],"expectedGoodIds":[1]}',
      match: /duplicate job ids/,
    },
    {
      label: "profile missing summary",
      line: '{"profile":{"id":"p1","skills":[],"targetRoles":[]},"candidateJobs":[],"expectedGoodIds":[]}',
      match: /summary must be a string/,
    },
    {
      label: "contentless job (blank title AND description)",
      line:
        '{"profile":{"id":"p1","summary":"s","skills":[],"targetRoles":[]},' +
        '"candidateJobs":[{"id":1,"title":"  ","descriptionText":""}],"expectedGoodIds":[]}',
      match: /job 1 has no embeddable content \(title and descriptionText are both empty\)/,
    },
    {
      label: "contentless profile (summary AND skills AND targetRoles empty)",
      line:
        '{"profile":{"id":"p1","summary":"  ","skills":[],"targetRoles":[]},' +
        '"candidateJobs":[{"id":1,"title":"t","descriptionText":"d"}],"expectedGoodIds":[]}',
      match: /profile has no embeddable content \(summary, skills, and targetRoles compose to ""\)/,
    },
  ])("rejects $label", ({ line, match }) => {
    expect(() => parseDatasetLines(line)).toThrow(match);
  });

  it("prefixes errors with the 1-based line number", () => {
    // Blank first line is skipped, so the malformed JSON is reported at line 2, not line 1.
    expect(() => parseDatasetLines('\n{"profile":')).toThrow(/dataset:2:/);
  });
});
