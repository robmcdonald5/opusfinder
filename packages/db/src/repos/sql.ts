/**
 * Tiny SQL/text primitives shared across the repo modules (jobs, embeddings, profiles): NUL
 * stripping for Postgres text/jsonb, and the pgvector literal + `::vector(N)` cast built from the
 * single dimension constant. Centralized here (Phase 9, when profiles became a third consumer) so
 * the NUL rule and the vector cast each have ONE definition instead of a per-file copy.
 */
import { sql } from "drizzle-orm";

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
