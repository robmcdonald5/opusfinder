import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Production data fixes: numbered SQL files in `packages/db/fixes/`, each applied ONCE, in order, by the
 * `data-fixes` GitHub Action (scripts/apply-fixes.ts) as the limited `data_fixer` role. See fixes/README.md.
 * This module is the shared core: read + lint the directory (also the secret-free PR check,
 * scripts/check-fixes.ts) and apply the pending fixes over any client that can run raw SQL.
 */

/** The fixes directory, resolved from this module so every caller agrees regardless of cwd. */
export const FIXES_DIR = fileURLToPath(new URL("../fixes", import.meta.url));

/** `NNNN-<kebab-slug>.sql`. NNNN is the fix's id and its apply order. */
const FIX_NAME_RE = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/;

/** The only non-fix file the directory may hold. */
const README = "README.md";

/** A fix's read-only preview queries live in a block comment opened by `/* preview` (see the README). */
const PREVIEW_RE = /\/\*\s*preview\b/i;

/** Words that may not appear anywhere in a fix's code, DO-block bodies included, and why. */
const FORBIDDEN_WORDS: Record<string, string> = {
  CREATE: "DDL",
  ALTER: "DDL",
  DROP: "DDL",
  TRUNCATE: "DDL",
  GRANT: "a privilege change",
  REVOKE: "a privilege change",
  COMMIT: "transaction control (the runner owns the transaction)",
  ROLLBACK: "transaction control (the runner owns the transaction)",
  SAVEPOINT: "transaction control (the runner owns the transaction)",
  EXECUTE: "dynamic SQL (it hides the real statement from this check and from review)",
};

/** Top-level statements a fix may not start with: transaction control belongs to the runner. Checked only at
 * statement starts because PL/pgSQL uses BEGIN/END for its blocks and SQL uses END in CASE. */
const TX_CONTROL_STARTS = new Set(["BEGIN", "START", "END", "ABORT", "RELEASE", "PREPARE"]);

export interface FixFile {
  /** The NNNN number: apply order and the `data_fixes.id` key. */
  id: number;
  /** File name, e.g. `0001-merge-case-variant-boards.sql`. */
  name: string;
  sql: string;
  /** sha256 of the content with CRLF normalized to LF, so a Windows checkout hashes the same as CI. */
  sha256: string;
}

export function fixSha256(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

/** Read {@link FIXES_DIR} (or `dir`) and check it with {@link parseFixes}. */
export function readFixes(dir: string = FIXES_DIR): { fixes: FixFile[]; problems: string[] } {
  const files: { name: string; content: string }[] = [];
  const problems: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === README) continue;
    if (!entry.isFile())
      problems.push(`${entry.name}: unexpected entry (only fix files and ${README})`);
    else files.push({ name: entry.name, content: readFileSync(join(dir, entry.name), "utf8") });
  }
  const parsed = parseFixes(files);
  return { fixes: parsed.fixes, problems: [...problems, ...parsed.problems] };
}

/**
 * Validate a set of fix files: names match `NNNN-<slug>.sql`, numbers run 0001..N with no gap or duplicate, and
 * each file passes {@link lintFixSql}. Returns the valid fixes ordered by number, plus every problem found.
 */
export function parseFixes(files: readonly { name: string; content: string }[]): {
  fixes: FixFile[];
  problems: string[];
} {
  const fixes: FixFile[] = [];
  const problems: string[] = [];
  for (const { name, content } of files) {
    const match = FIX_NAME_RE.exec(name);
    if (!match) {
      problems.push(`${name}: not a fix file name (expected NNNN-<kebab-slug>.sql)`);
      continue;
    }
    for (const p of lintFixSql(content)) problems.push(`${name}: ${p}`);
    fixes.push({ id: Number(match[1]), name, sql: content, sha256: fixSha256(content) });
  }
  fixes.sort((a, b) => a.id - b.id || a.name.localeCompare(b.name));

  const max = fixes.at(-1)?.id ?? 0;
  for (let id = 1; id <= max; id++) {
    const same = fixes.filter((f) => f.id === id);
    if (same.length === 0)
      problems.push(`numbering gap: no fix numbered ${String(id).padStart(4, "0")}`);
    if (same.length > 1) problems.push(`duplicate number: ${same.map((f) => f.name).join(", ")}`);
  }
  if (fixes.some((f) => f.id === 0)) problems.push("numbering starts at 0001, not 0000");
  return { fixes, problems };
}

/** Lint one fix file. Returns human-readable problems; empty means it may be applied. */
export function lintFixSql(sql: string): string[] {
  const problems: string[] = [];
  if (!PREVIEW_RE.test(sql))
    problems.push("missing the `/* preview` block comment of read-only SELECTs");

  const { code, statements } = scanSql(sql);
  if (statements.length === 0) problems.push("has no apply SQL");
  for (const stmt of statements) {
    const first = /^[A-Za-z]+/.exec(stmt.trim())?.[0].toUpperCase();
    if (first && TX_CONTROL_STARTS.has(first)) {
      problems.push(`starts a statement with ${first}: the runner owns the transaction`);
    }
  }
  const found = new Set(
    [...code.matchAll(/\b[A-Za-z]+\b/g)]
      .map((m) => m[0].toUpperCase())
      .filter((w) => w in FORBIDDEN_WORDS),
  );
  for (const word of found)
    problems.push(`contains ${word}: ${FORBIDDEN_WORDS[word]} is not allowed in a fix`);
  return problems;
}

/**
 * Reduce SQL to its code: comments and quoted strings/identifiers are blanked, so a keyword inside a RAISE
 * message or a comment can't trip {@link lintFixSql}. Dollar-quoted bodies are KEPT as code (a DO block's body
 * is PL/pgSQL and is checked too). Also returns the top-level statements (split on `;` outside dollar quotes),
 * blank ones dropped. A lint aid, not a full SQL lexer: the `data_fixer` role's grants are the real boundary.
 */
export function scanSql(sql: string): { code: string; statements: string[] } {
  let code = "";
  let stmt = "";
  const statements: string[] = [];
  const dollar: string[] = []; // open $tag$ delimiters, innermost last
  const emit = (s: string) => {
    code += s;
    stmt += s;
  };
  const isWordChar = (ch: string | undefined) => ch !== undefined && /[\w$]/.test(ch);

  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (ch === "-" && sql[i + 1] === "-") {
      const eol = sql.indexOf("\n", i);
      i = eol === -1 ? sql.length : eol;
      emit(" ");
    } else if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1; // Postgres block comments nest
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      emit(" ");
    } else if (ch === "'" || ch === '"') {
      // '' / "" escape a quote; an E'...' string also takes backslash escapes.
      const backslash = ch === "'" && /[eE]/.test(sql[i - 1] ?? "") && !isWordChar(sql[i - 2]);
      i++;
      while (i < sql.length) {
        if (backslash && sql[i] === "\\") i += 2;
        else if (sql[i] === ch && sql[i + 1] === ch) i += 2;
        else if (sql[i] === ch) break;
        else i++;
      }
      i++;
      emit(" ");
    } else if (ch === "$" && !isWordChar(sql[i - 1])) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))?.[0];
      if (tag === undefined) {
        emit(ch);
        i++;
      } else {
        if (dollar.at(-1) === tag) dollar.pop();
        else dollar.push(tag);
        emit(" ");
        i += tag.length;
      }
    } else if (ch === ";" && dollar.length === 0) {
      code += ch;
      statements.push(stmt);
      stmt = "";
      i++;
    } else {
      emit(ch);
      i++;
    }
  }
  statements.push(stmt);
  return { code, statements: statements.filter((s) => s.trim() !== "") };
}

/**
 * The SQL surface the runner needs. `query` without params may hold several statements (the fix itself) and
 * returns the rows of the last one. `takeNotices` returns the RAISE NOTICE messages received since its last
 * call, oldest first.
 */
export interface FixClient {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  takeNotices(): string[];
}

export interface FixOutcome {
  fix: FixFile;
  notices: string[];
  /** Set when the fix failed; its transaction was rolled back. */
  error?: string;
}

export interface FixRun {
  /** Fixes already recorded in `data_fixes` before this run (skipped). */
  alreadyApplied: number;
  /** One per fix attempted, in order. Only the last can have an `error`: the run stops at the first failure. */
  outcomes: FixOutcome[];
}

/**
 * Apply every fix not yet recorded in `data_fixes`, in order, each in ONE transaction together with the insert
 * of its record, so a fix is applied and recorded atomically and never twice (a concurrent duplicate fails on
 * the primary key and rolls back). Stops at the first failing fix. Throws before applying anything if an
 * already-applied fix's file no longer matches the sha256 recorded when it ran.
 */
export async function applyPendingFixes(
  db: FixClient,
  fixes: readonly FixFile[],
  gitSha: string | null,
): Promise<FixRun> {
  const recorded = new Map<number, string>();
  for (const row of await db.query("SELECT id, sha256 FROM data_fixes")) {
    recorded.set(Number(row.id), String(row.sha256));
  }
  for (const fix of fixes) {
    const sha = recorded.get(fix.id);
    if (sha !== undefined && sha !== fix.sha256) {
      throw new Error(
        `${fix.name} changed after it was applied (sha256 ${sha.slice(0, 12)} recorded, ` +
          `${fix.sha256.slice(0, 12)} on disk). Restore the applied version; write a new fix instead.`,
      );
    }
  }

  const outcomes: FixOutcome[] = [];
  for (const fix of fixes) {
    if (recorded.has(fix.id)) continue;
    db.takeNotices();
    try {
      await db.query("BEGIN");
      await db.query(fix.sql);
      await db.query("INSERT INTO data_fixes (id, name, sha256, git_sha) VALUES ($1, $2, $3, $4)", [
        fix.id,
        fix.name,
        fix.sha256,
        gitSha,
      ]);
      await db.query("COMMIT");
      outcomes.push({ fix, notices: db.takeNotices() });
    } catch (err) {
      const notices = db.takeNotices();
      await db.query("ROLLBACK").catch(() => undefined);
      outcomes.push({ fix, notices, error: err instanceof Error ? err.message : String(err) });
      break;
    }
  }
  return { alreadyApplied: fixes.filter((f) => recorded.has(f.id)).length, outcomes };
}

/** Markdown report of a run: printed to the log and appended to the GitHub Actions job summary. */
export function formatFixRun(run: FixRun): string {
  const lines = ["## Data fixes", ""];
  if (run.outcomes.length === 0)
    lines.push(`Nothing to apply (${run.alreadyApplied} already applied).`, "");
  for (const { fix, notices, error } of run.outcomes) {
    lines.push(`### ${fix.name}: ${error === undefined ? "applied" : "FAILED, rolled back"}`, "");
    if (notices.length > 0) lines.push("```", ...notices, "```", "");
    if (error !== undefined) lines.push("Error:", "```", error, "```", "");
  }
  return lines.join("\n");
}
