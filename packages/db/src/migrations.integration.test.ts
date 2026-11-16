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

  it("0035 keeps emailing the accounts that hold the send permit, and a re-run changes nothing", async () => {
    const index = journalTags().indexOf("0035_digest_delivery");
    const statements = readMigrationFiles({ migrationsFolder: DRIZZLE })[index]!.sql;
    const deliveryOf = async () =>
      (
        await client.query<{ name: string; digest_delivery: string }>(
          `SELECT u.name, p.digest_delivery FROM user_preferences p JOIN "user" u ON u.id = p.user_id ORDER BY u.name`,
        )
      ).rows.map((r) => [r.name, r.digest_delivery]);

    // The table as it was before 0035, with one permitted and one unpermitted account.
    await client.exec(`ALTER TABLE user_preferences DROP COLUMN digest_delivery`);
    await client.exec(`
      INSERT INTO "user" (id, name, email) VALUES
        ('00000000-0000-4000-8000-000000000001', 'permitted', 'a@migration.test'),
        ('00000000-0000-4000-8000-000000000002', 'unpermitted', 'b@migration.test');
      INSERT INTO user_preferences (user_id, unsubscribe_token, digest_approved_at) VALUES
        ('00000000-0000-4000-8000-000000000001', 'tok-a', now()),
        ('00000000-0000-4000-8000-000000000002', 'tok-b', NULL);
    `);

    for (const statement of statements) await client.exec(statement);
    expect(await deliveryOf()).toEqual([
      ["permitted", "email"],
      ["unpermitted", "logs"],
    ]);

    // Someone sets the permitted account to logs; a migrate that re-runs 0035 must not undo that.
    await client.exec(`UPDATE user_preferences SET digest_delivery = 'logs'`);
    for (const statement of statements) await client.exec(statement);
    expect(await deliveryOf()).toEqual([
      ["permitted", "logs"],
      ["unpermitted", "logs"],
    ]);
  });
});

function journalTags(): string[] {
  const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  return journal.entries.map((entry) => entry.tag);
}
