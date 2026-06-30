import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { schema, type Db } from "@opusfinder/db";

// The REAL packages/db/drizzle migration set, resolved relative to THIS file (repo-root test/db/), so a
// new migration is picked up automatically — the fixture is never a hand-maintained schema copy.
const MIGRATIONS = fileURLToPath(new URL("../../packages/db/drizzle", import.meta.url));

/**
 * Spin up an in-process PGlite (WASM Postgres 17) with pgvector, apply the real drizzle migrations, and
 * return a drizzle client cast to the repo's `Db`.
 *
 * The `as unknown as Db` cast is the documented R1 compromise: `Db` is the neon-http client type and the
 * PGlite drizzle client is a structurally-different driver, but every repo path the tests exercise — the
 * typed query builder AND raw `db.execute(sql\`...\`)` normalized through `resultRows()` — runs unmodified
 * (confirmed by the Phase 0 pilot, including the `<=>` cosine query and the HNSW-indexed migrations).
 *
 * Usage: one instance per test file in `beforeAll`; `truncate` touched tables in `beforeEach` when a file
 * has multiple tests; ALWAYS `await close()` in `afterAll` to drain the WASM handle (Windows teardown).
 *
 * CAVEATS: PGlite is single-user WASM — correct `<=>` ordering on small sets but NOT production HNSW
 * recall, and it cannot represent neon-serverless interactive transactions (those stay real-Neon live
 * gates). See VITEST_MIGRATION_PLAN §2.4 / §8.
 */
export async function createTestDb(): Promise<{
  db: Db;
  client: PGlite;
  close: () => Promise<void>;
}> {
  const client = new PGlite({ extensions: { vector } });
  // Migrate the properly-typed PGlite client BEFORE casting — the pglite migrator needs the real
  // PgliteDatabase type; the `as unknown as Db` happens only on the value handed back to the repos.
  const pglite = drizzle(client, { schema });
  await migrate(pglite, { migrationsFolder: MIGRATIONS });
  return { db: pglite as unknown as Db, client, close: () => client.close() };
}
