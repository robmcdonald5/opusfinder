import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { render } from "@test/db/render";

import { collapseBySignature } from "./retrieval";
import { normalizeSignatureText, signatureSql, textArrayLiteral } from "./sql";

// Leaf pure-unit for the content-dedup signature — the JS-decidable surface, NO Postgres, NO creds.
// Ports scripts/test-content-signature.ts. It locks four things without a live table:
//   - normalizeSignatureText (the JS mirror): case + whitespace + trailing-newline variants of the same
//     content fold to ONE string; distinct content does not.
//   - signatureSql renders the intended SQL at BOTH call-site forms (excluded.* SET vs bound VALUES),
//     including the LOAD-BEARING guard that the pattern is `[[:space:]]+`, not a cooked `\s`.
//   - the full JS signature (normalize + md5) is deterministic, collides on equal content, is 32 hex.
//   - collapseBySignature keeps one member per signature group and never collapses NULLs; textArrayLiteral
//     renders the repost anti-join's text[] param with escaping.
// The SQL md5 SEMANTICS (byte parity across INSERT/SET/backfill, real re-ingest no-op) are the live gate's job.

/**
 * The full JS-side signature: SQL `md5` over normalizeSignatureText's output. TEST-ONLY — node:crypto
 * never enters the Worker bundle, and production signs EXCLUSIVELY via signatureSql (SQL md5). Declared
 * locally here rather than imported so production stays free of node:crypto.
 */
function jsSignature(title: string, desc: string): string {
  return createHash("md5").update(normalizeSignatureText(title, desc)).digest("hex");
}

describe("normalizeSignatureText — JS mirror of the SQL normalization", () => {
  it("folds case + internal-whitespace + trailing-newline variants of the same content to one string", () => {
    expect(normalizeSignatureText("Senior   Engineer", "Build\tThings\n")).toBe(
      normalizeSignatureText("senior engineer", "build things"),
    );
  });

  it("trims leading/trailing and collapses internal runs ('  A  B  ' -> 'a b')", () => {
    expect(normalizeSignatureText("  A  B  ", "")).toBe("a b");
  });

  it("normalizes genuinely different content differently (no false merge)", () => {
    expect(normalizeSignatureText("Engineer", "x")).not.toBe(normalizeSignatureText("Manager", "x"));
  });
});

describe("signatureSql — rendered SQL at both call-site forms", () => {
  it("SET form (excluded.* column refs) inlines the columns, binds no params, and uses [[:space:]] not \\s", () => {
    const { sql: text, params } = render(
      signatureSql(sql`excluded.title`, sql`excluded.description_text`),
    );

    for (const piece of [
      "md5(",
      "btrim(",
      "regexp_replace(",
      "lower(",
      "chr(10)",
      "'[[:space:]]+'",
      "excluded.title",
      "excluded.description_text",
    ]) {
      expect(text).toContain(piece);
    }

    // LOCK the wrapper NESTING/ORDER — substring-PRESENCE alone would still pass if the wrappers were
    // re-nested (e.g. regexp_replace(btrim(...)) instead of btrim(regexp_replace(...)), or md5 applied to
    // the wrong subexpr). Assert the outermost→innermost chain md5 ⊃ btrim ⊃ regexp_replace ⊃ lower.
    expect(text).toMatch(/md5\(\s*btrim\(\s*regexp_replace\(\s*lower\(/);
    // …and inside lower(...) the title/desc are joined by `|| chr(10) ||`, which must PRECEDE the
    // whitespace-collapse pattern `'[[:space:]]+'` (the 2nd arg to regexp_replace). Locks concat→pattern order.
    expect(text).toMatch(/\|\|\s*chr\(10\)\s*\|\|[\s\S]*'\[\[:space:\]\]\+'/);

    // LOAD-BEARING negative guard: a `\s+` in the tagged template would cook to a bare `s` and silently
    // stop collapsing whitespace. Keep this — it is the whole reason the pattern is the POSIX class.
    expect(text).not.toContain("\\s");
    expect(params).toHaveLength(0);
  });

  it("VALUES form (bound values) binds [title, desc] as params and keeps chr(10) + [[:space:]]+", () => {
    const { sql: text, params } = render(signatureSql(sql`${"My Title"}`, sql`${"My Desc"}`));

    expect(text).toContain("chr(10)");
    expect(text).toContain("'[[:space:]]+'");
    // Same wrapper NESTING/ORDER lock as the SET form: md5 ⊃ btrim ⊃ regexp_replace ⊃ lower, with the
    // `|| chr(10) ||` concat inside lower(...) preceding the `'[[:space:]]+'` collapse pattern.
    expect(text).toMatch(/md5\(\s*btrim\(\s*regexp_replace\(\s*lower\(/);
    expect(text).toMatch(/\|\|\s*chr\(10\)\s*\|\|[\s\S]*'\[\[:space:\]\]\+'/);
    expect(params).toHaveLength(2);
    expect(params).toEqual(["My Title", "My Desc"]);
  });
});

describe("jsSignature — full normalize + md5", () => {
  it("is deterministic and collides on normalize-equal content", () => {
    const sigA = jsSignature("Staff   SWE", " Remote OK ");
    const sigB = jsSignature("staff swe", "remote ok");
    expect(sigA).toBe(sigB);
    // Deterministic: the same input re-hashes to the same value.
    expect(jsSignature("Staff   SWE", " Remote OK ")).toBe(sigA);
  });

  it("hashes distinct content differently", () => {
    expect(jsSignature("a", "b")).not.toBe(jsSignature("c", "d"));
  });

  it("is 32 lowercase hex chars (md5)", () => {
    expect(jsSignature("Staff   SWE", " Remote OK ")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("collapseBySignature — first-per-group wins, NULLs never collapse", () => {
  it("keeps the first member of each signature group, drops later dups, keeps every NULL", () => {
    const makeRow = (id: number, sig: string | null) => ({ id, contentSignature: sig });
    const kept = collapseBySignature([
      makeRow(1, "aaa"), // kept — first of group aaa
      makeRow(2, "bbb"), // kept — first of group bbb
      makeRow(3, "aaa"), // dropped — dup of #1
      makeRow(4, null), // kept — NULL is its own group
      makeRow(5, null), // kept — NULL never collapses
      makeRow(6, "bbb"), // dropped — dup of #2
    ]).map((x) => x.id);

    expect(kept).toEqual([1, 2, 4, 5]);
  });

  it("collapses an empty input to empty", () => {
    expect(collapseBySignature([])).toEqual([]);
  });
});

describe("textArrayLiteral — Postgres text[] literal for the repost anti-join param", () => {
  it.each([
    { name: "empty -> {}", input: [] as string[], expected: "{}" },
    {
      name: "md5-hex elements quote cleanly",
      input: ["abc123", "def456"],
      expected: '{"abc123","def456"}',
    },
    {
      name: "escapes backslash and double-quote",
      input: ['a"b', "c\\d"],
      expected: '{"a\\"b","c\\\\d"}',
    },
  ])("$name", ({ input, expected }) => {
    expect(textArrayLiteral(input)).toBe(expected);
  });
});
