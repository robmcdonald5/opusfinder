import type { Db } from "@opusfinder/db";

// A shared stub for the raw-SQL db repos (lifecycle, prune) that emit ONLY `await db.execute(sql`...`)`
// and never the typed query builder. It fakes `.execute`, capturing each drizzle `sql` query OBJECT into
// `calls` (render them later via `@test/db/render` to assert the SQL text / params) and returning whatever
// `respond` yields for that query — production wraps the result in `resultRows()`, which passes a plain
// rows array through unchanged, so `respond` returns the canned rows (bigint counts as STRINGS, as neon
// returns them). A no-op repo path (empty id set) never calls `.execute`, so a test asserts `calls.length
// === 0`. `respond` gets the raw query so a suite can dispatch on its rendered SQL (count vs DELETE).
export function stubExecDb(respond: (query: unknown) => unknown): { db: Db; calls: unknown[] } {
  const calls: unknown[] = [];
  const db = {
    execute: async (query: unknown) => {
      calls.push(query);
      return respond(query);
    },
  } as unknown as Db;
  return { db, calls };
}
