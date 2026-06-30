import { describe, expect, it } from "vitest";

import { cosineSimilarity } from "./cosine";

// Leaf pure-unit. The embedding ranker scores a candidate pool in memory with this, so the
// load-bearing contract is the [-1, 1] range, the zero-vector guard (return 0, never divide by
// zero), and the throw on a length mismatch (a provider / dimension bug must fail loud, not
// silently return a meaningless number). Ports the cosine cases from scripts/test-metrics.ts.
describe("cosineSimilarity", () => {
  it.each([
    { label: "identical", a: [1, 0], b: [1, 0], expected: 1 },
    { label: "orthogonal", a: [1, 0], b: [0, 1], expected: 0 },
    { label: "parallel (unnormalized)", a: [1, 1], b: [1, 1], expected: 1 },
    { label: "opposite", a: [1, 0], b: [-1, 0], expected: -1 },
    { label: "zero-vector → 0, not NaN", a: [0, 0], b: [1, 1], expected: 0 },
    { label: "both empty (length match, no direction) → 0", a: [], b: [], expected: 0 },
  ])("$label → $expected", ({ a, b, expected }) => {
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 9);
  });

  it("throws on a length mismatch (dimension / provider bug)", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/length mismatch/);
  });
});
