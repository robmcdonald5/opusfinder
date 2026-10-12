import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb } from "@test/db/pglite";

const DRIZZLE = fileURLToPath(new URL("../drizzle", import.meta.url));

// Prod migrates with drizzle's neon-http migrator, which runs each statement on its own and records the
// applied migrations only after all of them succeed. So when a migrate fails partway, the next one re-runs
// every pending migration from its first statement, over a schema that already has some of them. The test
// fixture migrates in one transaction and never sees that, so this re-runs every statement over the fully
// migrated schema: each must be guarded (IF NOT EXISTS / IF EXISTS / a DO block) to succeed a second time.
describe("drizzle migrations re-run over the migrated schema (integration: real PGlite)", () => {
  let client: PGlite;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ client, close } = await createTestDb());
  });
  afterAll(async () => {
    await close?.();
  });

  it("runs every statement of every migration again without an error", async () => {
    const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    const failures: string[] = [];
    for (const [i, migration] of readMigrationFiles({ migrationsFolder: DRIZZLE }).entries()) {
      for (const [j, statement] of migration.sql.entries()) {
        try {
          await client.exec(statement);
        } catch (err) {
          failures.push(`${journal.entries[i]?.tag} statement ${j + 1}: ${(err as Error).message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
