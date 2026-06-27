/**
 * Tiny SQL/text primitives shared across the repo modules (jobs, embeddings, profiles): NUL
 * stripping for Postgres text/jsonb, the pgvector literal + `::vector(N)` cast built from the
 * single dimension constant, and the content-dedup signature expression. Centralized here so the
 * NUL rule, the vector cast, and the signature normalization each have ONE definition instead of a
 * per-file copy.
 */
import { sql, type SQL } from "drizzle-orm";

import { EMBEDDING_DIMENSIONS } from "../schema";

/** The NUL code point (U+0000), constructed at runtime so this source file never contains an
 * actual NUL byte. */
export const NUL = String.fromCharCode(0);

/**
 * Recursively strip U+0000 (NUL) from every string in a JSON-origin value. Postgres `text` and
 * `jsonb` cannot store a NUL byte, so an unsanitized NUL in any field — or anywhere inside a nested
 * payload — would abort the whole insert. Safe to recurse over `JSON.parse` output (only
 * objects/arrays/strings/numbers/bools/null — no Dates or branded values to mangle).
 */
export function stripNul(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll(NUL, "");
  if (Array.isArray(value)) return value.map(stripNul);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k.replaceAll(NUL, ""), stripNul(v)]),
    );
  }
  return value;
}

/**
 * pgvector text literal: a JS number[] -> `[a,b,c]`. Asserts the width matches EMBEDDING_DIMENSIONS
 * up front so a wrong-length vector (an embedder model swap, a partial/empty response) fails with a
 * clear message here instead of as an opaque pgvector dimension-mismatch deep in Neon. Every vector
 * write/query (jobs + profiles) routes through this, so the guard lives in one place.
 */
export function vectorLiteral(vec: number[]): string {
  if (vec.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`vectorLiteral: expected ${EMBEDDING_DIMENSIONS} dimensions, got ${vec.length}`);
  }
  return `[${vec.join(",")}]`;
}

/**
 * The `::vector(N)` cast used by every embedding write/query, built once from the single dimension
 * constant (schema.ts) so a dimension change can't leave a stray literal behind. `sql.raw` is safe
 * here: EMBEDDING_DIMENSIONS is an in-code numeric constant, never input.
 */
export const VECTOR_CAST = sql.raw(`::vector(${EMBEDDING_DIMENSIONS})`);

/**
 * Render a JS number[] as a Postgres array literal for a bound `::int[]` param — one bound text param cast
 * to int[], which sidesteps the 65535 bind-param ceiling on a large `= ANY` / `<> ALL` list. Shared by the
 * retrieval anti-join and the F2 bulk-by-id close writers so the idiom (and its defensive `Math.trunc`,
 * which neutralizes a stray fractional id) lives in ONE place. Callers pass real integer row ids.
 */
export function intArrayLiteral(ids: number[]): string {
  return `{${ids.map((id) => Math.trunc(id)).join(",")}}`;
}

/**
 * Render a JS string[] as a Postgres array literal for a bound `::text[]` param — the TEXT sibling of
 * intArrayLiteral, used by the F1 shown-history repost anti-join's `content_signature <> ALL(...)` (a
 * long shown-history would otherwise blow the 65535 bind-param ceiling as individual params). Each
 * element is double-quoted with `\` and `"` escaped, so any text is safe (commas, braces, spaces). NUL
 * must not be present (Postgres text[] rejects U+0000); the only caller passes md5 hex, which is NUL-free.
 * Distinct from intArrayLiteral because text needs quoting/escaping that integers never do.
 */
export function textArrayLiteral(values: string[]): string {
  return `{${values.map((v) => `"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`;
}

/**
 * The SINGLE definition of the content-dedup signature EXPRESSION: md5 over an aggressively-NORMALIZED
 * title + description (lower → whitespace runs collapsed to a single space → trimmed). Built as a `sql`
 * fragment from two sub-expressions so the SAME normalization is reused at all three write call sites —
 * the upsertJobs INSERT VALUES (bound, NUL-stripped title/desc), the ON CONFLICT SET (`excluded.*`), and
 * the backfill UPDATE (column refs) — eliminating any write/backfill parity hazard (a JS write path + a
 * SQL backfill could emit non-byte-identical output and silently split signature groups). `md5` is
 * Postgres-core (no pgcrypto, no `node:crypto`, no async), so this stays one round-trip and Worker-safe.
 *
 * DISTINCT from jobEmbeddingText: that joins these same two fields RAW for a SEMANTIC embedding; this
 * FOLDS them into an EXACT-MATCH key. Same two fields, OPPOSITE purpose — never merge the two. The
 * `chr(10)` separator keeps a whitespace boundary between title and description. Normalization is MINIMAL
 * — NO punctuation stripping, to avoid false-merging short distinct titles.
 *
 * IMPLEMENTATION NOTE: the whitespace pattern is the POSIX class `[[:space:]]+`, NOT `\s+` — inside a
 * `sql` tagged TEMPLATE LITERAL the cooked escape `\s` would collapse to a bare `s` and silently match
 * the letter 's' instead of whitespace. `[[:space:]]` is backslash-free and equivalent to Postgres `\s`.
 */
export function signatureSql(titleExpr: SQL, descExpr: SQL): SQL {
  return sql`md5(btrim(regexp_replace(lower(${titleExpr} || chr(10) || ${descExpr}), '[[:space:]]+', ' ', 'g')))`;
}

/**
 * JS mirror of signatureSql's NORMALIZATION (lower + whitespace-collapse + btrim), returning the
 * normalized string the SQL `md5` hashes. EXISTS SOLELY to compute the expected value in the smoke
 * test — it is NEVER a production write path. Production signs EXCLUSIVELY via signatureSql, so a
 * JS/SQL divergence can never split a production signature group. Caveat: JS `\s` matches a broader
 * Unicode whitespace set than Postgres's, so the two can diverge on exotic whitespace (e.g. NBSP) —
 * negligible for ATS data, and harmless here because only the smoke consults this. A smoke wanting the
 * literal md5 hex can hash the returned string with `node:crypto` (a test-only import, never bundled
 * into the Worker).
 */
export function normalizeSignatureText(title: string, desc: string): string {
  return `${title}\n${desc}`.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Extract the rows array from a neon-http `db.execute` result without depending on its exact shape
 * (drizzle has returned either the raw rows array or a `{ rows }` object across versions). Shared by
 * the raw-SQL query paths that can't use the typed query builder (the `<=>` cosine queries in
 * embeddings.ts and retrieval.ts).
 */
export function resultRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result !== null && typeof result === "object") {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows;
  }
  return [];
}
