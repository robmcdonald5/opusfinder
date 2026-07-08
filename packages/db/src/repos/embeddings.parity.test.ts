import { describe, expect, it } from "vitest";

import { embeddableContentSql, jobEmbeddingText } from "@opusfinder/db/repos";

import { render } from "@test/db/render";

// Ports scripts/test-embedding-backlog-parity.ts. Locks BOTH halves of the F8 cursorless-drain contract:
//   - the JS empty-notion: jobEmbeddingText (→ composeEmbeddingText, parts.filter(trim().length>0)) is
//     empty IFF neither title nor description has a non-whitespace char.
//   - the SQL predicate: embeddableContentSql tests title OR description_text for a non-whitespace char
//     (`~ '[^[:space:]]'`), rendered via PgDialect (no DB).
// If the two notions drift, an un-embeddable row is re-selected every run (wasteful Voyage 400s on "") or a
// row with content is silently never embedded. Whitespace fixtures are ASCII ONLY — JS \s and SQL
// `[^[:space:]]` diverge on exotic Unicode (e.g. NBSP), so those are deliberately out of scope here.

describe("jobEmbeddingText — JS empty-notion (empty IFF no non-whitespace char in title/desc)", () => {
  // Each row asserts the EXACT composed output (not just empty/non-empty): a whitespace-only part is
  // DROPPED (per composeEmbeddingText's `.trim().length > 0` filter), and a single surviving part is
  // returned alone with no separator. Locking the exact string catches a `.length`-vs-`.trim().length`
  // regression that a bare `not.toBe("")` would let through (a dropped part would leak back as content).
  const EMPTY_NOTION_ROWS = Object.freeze([
    // whitespace-only (ASCII space/tab/newline) in both fields → empty embed text (SQL must exclude it).
    { title: "   ", descriptionText: "\t\n ", expected: "" },
    // a non-whitespace char in the title alone → the blank description is DROPPED, title returned alone.
    // Mirrors the SQL OR (title matches `~ '[^[:space:]]'`).
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

describe("embeddableContentSql — SQL predicate parity (title OR description_text has content)", () => {
  it("tests jobs.title for a non-whitespace char with the ~ operator", () => {
    expect(render(embeddableContentSql).sql).toMatch(/"jobs"\."title"\s*~\s*'\[\^\[:space:\]\]'/);
  });

  it("tests jobs.description_text for a non-whitespace char with the ~ operator", () => {
    expect(render(embeddableContentSql).sql).toMatch(
      /"jobs"\."description_text"\s*~\s*'\[\^\[:space:\]\]'/,
    );
  });

  it("ORs the two column tests", () => {
    // Lock the OR *between* the two rendered column tests (not just an OR somewhere in the SQL): the
    // title `~ '[^[:space:]]'` test, then OR, then the description_text `~ '[^[:space:]]'` test.
    expect(render(embeddableContentSql).sql).toMatch(
      /"jobs"\."title"\s*~\s*'\[\^\[:space:\]\]'\s+OR\s+"jobs"\."description_text"\s*~\s*'\[\^\[:space:\]\]'/,
    );
  });

  it("inlines the '[^[:space:]]' class as a literal with quoted identifiers — no bound params", () => {
    const { sql, params } = render(embeddableContentSql);
    // The POSIX class is baked into the SQL template text, not a bound value.
    expect(params).toHaveLength(0);
    expect(sql).not.toContain("$1");
  });

  it("uses the case-sensitive ~ operator, NOT ~*", () => {
    expect(render(embeddableContentSql).sql).not.toMatch(/~\*/);
  });
});
