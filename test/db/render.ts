import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// One PgDialect renders a drizzle `sql` fragment to its parameterized form WITHOUT a database — the seam
// the db unit suites (content-signature, embeddings-parity, lifecycle, prune, and the health alert-gate)
// assert on. It proves the intended SQL TEXT + param binding only; real Postgres semantics (md5 / regexp /
// `<=>` / etc.) are the PGlite/live gate's job (see test/db/pglite.ts). No DB, no creds, deterministic.
const dialect = new PgDialect();

/** Render a drizzle `sql` fragment to `{ sql, params }` via PgDialect (no DB). */
export function render(query: SQL): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(query);
  return { sql, params };
}
