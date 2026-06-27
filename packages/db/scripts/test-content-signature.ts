import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { runScript } from "@opusfinder/shared/script";

import { collapseBySignature } from "../src/repos/retrieval";
import { normalizeSignatureText, signatureSql, textArrayLiteral } from "../src/repos/sql";

/**
 * Stub smoke for the content signature — the JS-decidable surface, NO creds, NO Postgres.
 * It locks three things without a live table:
 *   - normalizeSignatureText (the JS mirror): case + whitespace variants of the same content fold to
 *     ONE string; genuinely different content does not; leading/trailing trimmed, runs collapsed.
 *   - signatureSql renders the intended SQL at BOTH call-site forms: the bound-value form (INSERT
 *     VALUES) binds title/desc as params; the excluded.* form (ON CONFLICT SET) inlines the columns.
 *     The render also GUARDS the `[[:space:]]+` pattern — a `\s+` in the tagged template would cook to
 *     a bare `s` and silently stop collapsing whitespace.
 *   - the full JS signature (normalize + md5) is deterministic and collides on equal content.
 *   - collapseBySignature keeps one member per signature group and never collapses NULLs;
 *     textArrayLiteral renders the repost anti-join's text[] param (with escaping).
 *
 * The SQL md5 *semantics* (a real re-ingest no-op, the embedding+signature lockstep re-NULL, byte
 * parity between the INSERT/SET/backfill expressions) are only fully assertable against a real table —
 * that is the live gate's job.
 *
 *   pnpm --filter @opusfinder/db test:signature
 */
const dialect = new PgDialect();

/** The full JS-side signature: SQL `md5` over normalizeSignatureText's output. Test-only — node:crypto
 *  never enters the Worker bundle, and production signs exclusively via signatureSql (SQL md5). */
function jsSignature(title: string, desc: string): string {
  return createHash("md5").update(normalizeSignatureText(title, desc)).digest("hex");
}

await runScript("test-content-signature", async () => {
  // 1) normalizeSignatureText: case + internal-whitespace + trailing-newline variants of the SAME
  //    logical content fold to one normalized string.
  assert(
    normalizeSignatureText("Senior   Engineer", "Build\tThings\n") ===
      normalizeSignatureText("senior engineer", "build things"),
    "case + whitespace variants must normalize equal",
  );

  // 2) Leading/trailing whitespace trimmed; internal runs collapsed to a single space.
  assert(normalizeSignatureText("  A  B  ", "") === "a b", "trim + collapse failed");

  // 3) Genuinely different content normalizes differently (no false merge).
  assert(
    normalizeSignatureText("Engineer", "x") !== normalizeSignatureText("Manager", "x"),
    "distinct titles must normalize differently",
  );

  // 4) signatureSql — the ON CONFLICT SET form (excluded.* inlined, no params).
  {
    const { sql: text, params } = rendered(
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
      assert(text.includes(piece), `SET-form signature SQL missing "${piece}": ${text}`);
    }
    assert(!text.includes("\\s"), `SET-form signature SQL must use [[:space:]], not \\s: ${text}`);
    assert(params.length === 0, `SET form must bind no params, got ${JSON.stringify(params)}`);
  }

  // 5) signatureSql — the INSERT VALUES form (title/desc bound as params, [[:space:]]+ preserved).
  {
    const { sql: text, params } = rendered(signatureSql(sql`${"My Title"}`, sql`${"My Desc"}`));
    assert(text.includes("chr(10)"), `VALUES-form must keep the chr(10) separator: ${text}`);
    assert(text.includes("'[[:space:]]+'"), `VALUES-form must keep [[:space:]]+: ${text}`);
    assert(
      params.length === 2 && params[0] === "My Title" && params[1] === "My Desc",
      `VALUES form must bind [title, desc], got ${JSON.stringify(params)}`,
    );
  }

  // 6) The full JS signature is deterministic, collides on normalize-equal content, separates distinct
  //    content, and is 32 hex chars (md5).
  const sigA = jsSignature("Staff   SWE", " Remote OK ");
  const sigB = jsSignature("staff swe", "remote ok");
  assert(sigA === sigB, "normalize-equal inputs must hash equal");
  assert(jsSignature("a", "b") !== jsSignature("c", "d"), "distinct content must hash differently");
  assert(/^[0-9a-f]{32}$/.test(sigA), `signature must be 32 hex chars, got "${sigA}"`);

  // 7) collapseBySignature: same-signature members collapse to the FIRST (closest, since the input
  //    is distance-sorted); a distinct signature after a dropped dup survives (the freed slot back-fills);
  //    NULL signatures never collapse.
  {
    const makeRow = (id: number, sig: string | null) => ({ id, contentSignature: sig });
    const keptIds = collapseBySignature([
      makeRow(1, "aaa"), // kept — first of group aaa
      makeRow(2, "bbb"), // kept — first of group bbb
      makeRow(3, "aaa"), // dropped — dup of #1
      makeRow(4, null), // kept — NULL is its own group
      makeRow(5, null), // kept — NULL never collapses
      makeRow(6, "bbb"), // dropped — dup of #2
    ]).map((x) => x.id);
    assert(
      JSON.stringify(keptIds) === JSON.stringify([1, 2, 4, 5]),
      `collapse kept wrong ids: ${JSON.stringify(keptIds)}`,
    );
    assert(collapseBySignature([]).length === 0, "empty input must collapse to empty");
  }

  // 8) textArrayLiteral (anti-join param): empty -> {}; md5-hex elements quote cleanly; backslash +
  //    double-quote escape (defensive — md5 hex never contains them, but the helper is general).
  assert(textArrayLiteral([]) === "{}", "empty text array must render {}");
  assert(
    textArrayLiteral(["abc123", "def456"]) === '{"abc123","def456"}',
    `md5-hex array literal wrong: ${textArrayLiteral(["abc123", "def456"])}`,
  );
  assert(
    textArrayLiteral(['a"b', "c\\d"]) === '{"a\\"b","c\\\\d"}',
    `escaping wrong: ${textArrayLiteral(['a"b', "c\\d"])}`,
  );

  console.log(
    "test-content-signature OK — normalize folds case/whitespace, signatureSql renders md5+[[:space:]]+ " +
      "at both call sites, JS signature deterministic + collision-on-equal, collapse drops same-sig + " +
      "keeps NULLs, textArrayLiteral escapes cleanly.",
  );
});

/** Render a `sql` fragment to its { sql, params } form via PgDialect — no DB. */
function rendered(query: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]);
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
