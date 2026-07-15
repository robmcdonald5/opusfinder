import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Db } from "@opusfinder/db";

/**
 * Reset the given tables between tests — the `beforeEach` companion to `createTestDb` (see ./pglite).
 * `RESTART IDENTITY` rewinds serial sequences so any auto-assigned ids restart at 1 each test (the
 * original per-suite idiom; suites that seed explicit ids don't rely on it, but keeping it matches the
 * hand-written SQL it replaces), and `CASCADE` follows FKs so a partial table list can't ERROR on a
 * dependent row (truncate ONLY the tables a file touches — order is irrelevant under CASCADE).
 *
 * Pass drizzle TABLE OBJECTS, never bare names: `sql`${table}`` emits the driver-quoted identifier,
 * which is what makes the reserved `"user"` table truncatable (a bareword `TRUNCATE TABLE user` is a
 * Postgres syntax error) and stops a hand-typed string from silently drifting when a table is renamed.
 * The non-empty tuple type rejects a zero-table call at compile time (which would render invalid
 * `TRUNCATE TABLE  RESTART IDENTITY`).
 */
export async function truncate(db: Db, ...tables: [PgTable, ...PgTable[]]): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE ${sql.join(
      tables.map((t) => sql`${t}`),
      sql`, `,
    )} RESTART IDENTITY CASCADE`,
  );
}
