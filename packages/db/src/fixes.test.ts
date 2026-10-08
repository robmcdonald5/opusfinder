import { describe, expect, it } from "vitest";

import {
  fixSha256,
  formatFixRun,
  lintFixSql,
  parseFixes,
  readFixes,
  scanSql,
  type FixFile,
} from "./fixes";

// Pure-unit suite for the data-fix file rules (the same checks `pnpm guard:fixes` and the runner apply): the
// committed fixes directory is valid, the SQL lint flags transaction control / DDL / privilege / dynamic SQL in
// CODE but not in comments or strings, and numbering has no gap or duplicate. Applying fixes against a real
// Postgres (transaction, record, guards, the data_fixer grants) is fixes.integration.test.ts.

const PREVIEW = "/* preview\nSELECT 1;\n*/\n";

describe("the committed fixes directory", () => {
  it("is valid and numbered 0001..N", () => {
    const { fixes, problems } = readFixes();
    expect(problems).toEqual([]);
    expect(fixes.map((f) => f.id)).toEqual(fixes.map((_, i) => i + 1));
  });
});

describe("lintFixSql", () => {
  it("accepts guarded DO blocks, CASE ... END, and forbidden words inside comments and strings", () => {
    const sql = `${PREVIEW}-- we never DROP or CREATE anything here
DO $$
DECLARE n int;
BEGIN
  UPDATE companies SET active = false WHERE id = 1 AND active;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 1 THEN RAISE EXCEPTION 'would ALTER % rows; ROLLBACK', n; END IF;
  RAISE NOTICE 'deactivated %', n;
END $$;
UPDATE jobs SET title = CASE WHEN title = '' THEN 'untitled' ELSE title END WHERE "Title" IS NULL;
SELECT E'it\\'s fine; COMMIT';`;
    expect(lintFixSql(sql)).toEqual([]);
  });

  it.each([
    ["a top-level BEGIN", "BEGIN;\nUPDATE jobs SET title = 'x';", /starts a statement with BEGIN/],
    [
      "START TRANSACTION",
      "START TRANSACTION;\nUPDATE jobs SET title = 'x';",
      /starts a statement with START/,
    ],
    ["a bare END (= COMMIT)", "UPDATE jobs SET title = 'x';\nEND;", /starts a statement with END/],
    ["COMMIT", "UPDATE jobs SET title = 'x';\nCOMMIT;", /contains COMMIT/],
    ["ROLLBACK inside a DO body", "DO $$ BEGIN ROLLBACK; END $$;", /contains ROLLBACK/],
    ["SAVEPOINT", "SAVEPOINT a;\nUPDATE jobs SET title = 'x';", /contains SAVEPOINT/],
    ["DROP", "DROP TABLE jobs;", /contains DROP: DDL/],
    [
      "CREATE inside a DO body",
      "DO $body$ BEGIN CREATE TABLE t (a int); END $body$;",
      /contains CREATE: DDL/,
    ],
    ["ALTER", "ALTER TABLE jobs ADD COLUMN x int;", /contains ALTER: DDL/],
    ["TRUNCATE", "TRUNCATE jobs;", /contains TRUNCATE: DDL/],
    ["GRANT", "GRANT SELECT ON jobs TO public;", /contains GRANT: a privilege change/],
    ["REVOKE", "REVOKE SELECT ON jobs FROM public;", /contains REVOKE: a privilege change/],
    [
      "dynamic SQL",
      "DO $$ BEGIN EXECUTE 'DEL' || 'ETE FROM jobs'; END $$;",
      /contains EXECUTE: dynamic SQL/,
    ],
    [
      "a top-level END after a body that quotes another $tag$",
      "DO $$ BEGIN PERFORM $y$ has $x$ inside $y$; END $$;\nEND;",
      /starts a statement with END/,
    ],
    [
      "writing the applied-fix record",
      "INSERT INTO data_fixes (id, name, sha256) VALUES (2, 'x', 'y');",
      /references data_fixes/,
    ],
    [
      "a quoted data_fixes",
      `DO $$ BEGIN INSERT INTO public."data_fixes" VALUES (2, 'x', 'y'); END $$;`,
      /references data_fixes/,
    ],
  ])("rejects %s", (_label, apply, expected) => {
    expect(lintFixSql(`${PREVIEW}${apply}`).join("\n")).toMatch(expected);
  });

  it("requires the preview block and some apply SQL", () => {
    expect(lintFixSql("UPDATE jobs SET title = 'x';")).toEqual([
      "missing the `/* preview` block comment of read-only SELECTs",
    ]);
    expect(lintFixSql(`-- header only\n${PREVIEW}`)).toEqual(["has no apply SQL"]);
  });
});

describe("scanSql", () => {
  it("keeps dollar-quoted bodies as code and splits only top-level statements", () => {
    const { code, statements } = scanSql(
      "DO $$ BEGIN PERFORM 1; END $$; /* x; */ SELECT 'a;b'; -- c;\n",
    );
    expect(statements.map((s) => s.trim())).toEqual(["DO   BEGIN PERFORM 1; END", "SELECT"]);
    expect(code).toContain("PERFORM 1");
    expect(code).not.toContain("a;b");
  });
});

describe("parseFixes", () => {
  const file = (name: string) => ({ name, content: `${PREVIEW}UPDATE jobs SET title = 'x';\n` });

  it("orders fixes by number", () => {
    const { fixes, problems } = parseFixes([file("0002-b.sql"), file("0001-a.sql")]);
    expect(problems).toEqual([]);
    expect(fixes.map((f) => [f.id, f.name])).toEqual([
      [1, "0001-a.sql"],
      [2, "0002-b.sql"],
    ]);
  });

  it("flags bad names, gaps, duplicates and 0000", () => {
    const { problems } = parseFixes([
      file("0000-zero.sql"),
      file("0001-a.sql"),
      file("0001-again.sql"),
      file("0003-c.sql"),
      file("4-short.sql"),
      file("0005-Upper.sql"),
    ]);
    expect(problems).toEqual([
      "4-short.sql: not a fix file name (expected NNNN-<kebab-slug>.sql)",
      "0005-Upper.sql: not a fix file name (expected NNNN-<kebab-slug>.sql)",
      "duplicate number: 0001-a.sql, 0001-again.sql",
      "numbering gap: no fix numbered 0002",
      "numbering starts at 0001, not 0000",
    ]);
  });

  it("prefixes lint problems with the file name", () => {
    expect(
      parseFixes([{ name: "0001-a.sql", content: `${PREVIEW}DROP TABLE jobs;` }]).problems,
    ).toEqual(["0001-a.sql: contains DROP: DDL is not allowed in a fix"]);
  });

  it("hashes CRLF and LF checkouts of a file the same", () => {
    expect(fixSha256("a\r\nb\r\n")).toBe(fixSha256("a\nb\n"));
    expect(fixSha256("a\nb\n")).not.toBe(fixSha256("a\nb"));
  });
});

describe("formatFixRun", () => {
  const fix = (id: number): FixFile => ({ id, name: `000${id}-x.sql`, sql: "", sha256: "" });

  it("says when there is nothing to apply", () => {
    expect(formatFixRun({ alreadyApplied: 3, outcomes: [] })).toContain(
      "Nothing to apply (3 already applied).",
    );
  });

  it("lists applied and failed fixes with their notices and the error", () => {
    const md = formatFixRun({
      alreadyApplied: 0,
      outcomes: [
        { fix: fix(1), notices: ["moved 5 jobs"] },
        { fix: fix(2), notices: ["moved 1 job"], error: "guard tripped" },
      ],
    });
    expect(md).toContain("### 0001-x.sql: applied\n\n```\nmoved 5 jobs\n```");
    expect(md).toContain(
      "### 0002-x.sql: FAILED, rolled back\n\n```\nmoved 1 job\n```\n\nError:\n```\nguard tripped\n```",
    );
  });

  it("flags a COMMIT that did not confirm as an unknown outcome, not a rollback", () => {
    const md = formatFixRun({
      alreadyApplied: 0,
      outcomes: [{ fix: fix(1), notices: [], error: "connection lost", unconfirmed: true }],
    });
    expect(md).toContain("### 0001-x.sql: OUTCOME UNKNOWN: COMMIT did not confirm.");
    expect(md).not.toContain("rolled back");
  });

  it("reports an error that stopped the run before any fix", () => {
    expect(formatFixRun({ error: "DATA_FIX_DATABASE_URL is not set." })).toBe(
      "## Data fixes\n\nNothing applied:\n```\nDATA_FIX_DATABASE_URL is not set.\n```\n",
    );
  });
});
