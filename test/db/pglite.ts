import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { schema, type Db } from "@opusfinder/db";

import { openMigratedClient } from "./snapshot";

/**
 * Spin up an in-process PGlite (WASM Postgres 17) with pgvector carrying the full migrated schema, and
 * return a drizzle client cast to the repo's `Db`.
 *
 * Schema delivery is amortized: the `integration` project's globalSetup migrates ONCE and dumps a datadir
 * snapshot; each call here loads that snapshot (~5.5× faster than replaying the migrations, and
 * byte-identical — same tables, indexes, pgvector extension, `<=>` behavior, drizzle journal). On
 * a snapshot cache-miss (a non-vitest import) `openMigratedClient` falls back to a fresh migrate. See
 * `./snapshot.ts` and VITEST_MIGRATION_PLAN §10.1 (PGlite setup amortization).
 *
 * The `as unknown as Db` cast is the documented R1 compromise: `Db` is the neon-http client type and the
 * PGlite drizzle client is a structurally-different driver, but every repo path the tests exercise — the
 * typed query builder AND raw `db.execute(sql\`...\`)` normalized through `resultRows()` — runs unmodified
 * (confirmed by the Phase 0 pilot, including the `<=>` cosine query and the pgvector migrations).
 *
 * Usage: one instance per test file in `beforeAll`; reset touched tables between tests with
 * `truncate(db, ...tables)` (see ./truncate) in `beforeEach`; ALWAYS `await close()` in `afterAll` to
 * drain the WASM handle (Windows teardown).
 *
 * Driver parity with neon-http: `db.transaction()` rejects as it does in prod (pass `transactions: true`
 * only where the handle stands in for the neon-serverless AuthDb), and int8 comes back as a string (see
 * ./snapshot).
 *
 * CAVEATS: PGlite is single-user WASM — correct `<=>` ordering on small sets but not production scale,
 * and its transactions are not neon-serverless's (concurrency and isolation stay real-Neon live
 * gates). See VITEST_MIGRATION_PLAN §2.4 / §8.
 */
export async function createTestDb({ transactions = false } = {}): Promise<{
  db: Db;
  client: PGlite;
  close: () => Promise<void>;
}> {
  const client = await openMigratedClient();
  // Wrap the properly-typed PGlite client, then cast only the value handed back to the repos — the raw
  // `PgliteDatabase` type is preserved through migration/loading; `as unknown as Db` happens here alone.
  const pglite = drizzle(client, { schema });
  if (!transactions) {
    pglite.transaction = async () => {
      throw new Error("No transactions support in neon-http driver");
    };
  }
  return { db: pglite as unknown as Db, client, close: () => client.close() };
}
