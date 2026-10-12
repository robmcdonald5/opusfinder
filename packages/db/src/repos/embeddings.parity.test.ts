import { describe, expect, it } from "vitest";

import { jobEmbeddingText } from "@opusfinder/db/repos";

// The JS half of the F8 cursorless-drain contract: jobEmbeddingText (→ composeEmbeddingText,
// parts.filter(trim().length>0)) is empty IFF neither title nor description has a non-whitespace char.
// The SQL half — jobsNeedingEmbedding never selects a row that composes to "" — runs against real
// Postgres in embeddings.integration.test.ts, over every code point JS trim() strips.

describe("jobEmbeddingText — JS empty-notion (empty IFF no non-whitespace char in title/desc)", () => {
  // Each row asserts the EXACT composed output (not just empty/non-empty): a whitespace-only part is
  // DROPPED (per composeEmbeddingText's `.trim().length > 0` filter), and a single surviving part is
  // returned alone with no separator. Locking the exact string catches a `.length`-vs-`.trim().length`
  // regression that a bare `not.toBe("")` would let through (a dropped part would leak back as content).
  const EMPTY_NOTION_ROWS = Object.freeze([
    // whitespace-only (ASCII space/tab/newline) in both fields → empty embed text (SQL must exclude it).
    { title: "   ", descriptionText: "\t\n ", expected: "" },
    // a non-whitespace char in the title alone → the blank description is DROPPED, title returned alone.
    // Mirrors the SQL OR (the title alone has content).
    { title: "Engineer", descriptionText: "   ", expected: "Engineer" },
    // a non-whitespace char in the description alone → the blank title is DROPPED, description alone.
    { title: "  ", descriptionText: "Build things", expected: "Build things" },
    // genuinely empty strings in both → empty (the contentless row the drain must never re-select).
    { title: "", descriptionText: "", expected: "" },
  ] as const);

  it.each(EMPTY_NOTION_ROWS)(
    "title=$title descriptionText=$descriptionText → expected=$expected",
    ({ title, descriptionText, expected }) => {
      expect(jobEmbeddingText({ title, descriptionText })).toBe(expected);
    },
  );

  it("joins two non-blank fields with a blank line (\\n\\n)", () => {
    expect(jobEmbeddingText({ title: "Engineer", descriptionText: "Build things" })).toBe(
      "Engineer\n\nBuild things",
    );
  });
});
