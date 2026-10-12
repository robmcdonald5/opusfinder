import type { PGlite } from "@electric-sql/pglite";
import { getTableName } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { setUpRole } from "@test/db/role";
import { createTestDb } from "@test/db/pglite";

import { DATA_FIXER, SCRAPERS_WORKER, type LimitedRole } from "./roles";

// Each limited role's setup SQL under REAL Postgres semantics: it confines the role to exactly its grants,
// converges on re-run, and aborts rather than leave a table privilege it didn't grant. What each role can
// actually RUN is its user's suite: fixes.integration.test.ts (data_fixer) and
// packages/discovery/src/worker-role.integration.test.ts (scrapers_worker).

const PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
];

describe.each([DATA_FIXER, SCRAPERS_WORKER])(
  "$name role setup (integration: real PGlite semantics)",
  (role: LimitedRole) => {
    let pg: PGlite;
    let close: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      ({ client: pg, close } = await createTestDb());
      await setUpRole(pg, role);
    });

    afterEach(async () => {
      await pg.exec("RESET ROLE");
    });

    afterAll(async () => {
      await close?.();
    });

    it("grants exactly its allowlist, no attributes, no memberships and no DDL", async () => {
      // pg_tables, not information_schema.tables: the latter lists only tables the CURRENT role can access.
      const { rows } = await pg.query<{ table_name: string; privs: string }>(`
        SELECT tablename AS table_name,
               concat_ws(',', ${PRIVILEGES.map(
                 (p) =>
                   `CASE WHEN has_table_privilege('${role.name}', format('%I.%I', schemaname, tablename), '${p}') THEN '${p}' END`,
               ).join(", ")}) AS privs
        FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename`);
      const sorted = (privileges: readonly string[]) => [...privileges].sort().join(",");
      const granted = new Map(
        role.grants.flatMap((g) => g.tables.map((t) => [getTableName(t), sorted(g.privileges)])),
      );
      const actual = Object.fromEntries(
        rows.map((r) => [r.table_name, sorted(r.privs.split(",").filter(Boolean))]),
      );
      expect(actual).toEqual(
        Object.fromEntries(rows.map((r) => [r.table_name, granted.get(r.table_name) ?? ""])),
      );
      // The user-side tables really are in the checked set (a sanity check on the query, not the grants).
      expect(Object.keys(actual)).toEqual(
        expect.arrayContaining([
          "user",
          "session",
          "user_profiles",
          "user_preferences",
          "digest_items",
        ]),
      );

      const attrs = await pg.query<Record<string, boolean>>(`
        SELECT r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication AS elevated,
               EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS member_of_any,
               has_schema_privilege(r.rolname, 'public', 'CREATE') AS can_create
        FROM pg_roles r WHERE r.rolname = '${role.name}'`);
      expect(attrs.rows).toEqual([{ elevated: false, member_of_any: false, can_create: false }]);
      await pg.exec(`SET ROLE ${role.name}`);
      await expect(pg.query("SELECT count(*) FROM session")).rejects.toThrow(/permission denied/);
      await expect(pg.exec("CREATE TABLE sneaky (a int)")).rejects.toThrow(/permission denied/);
    });

    it("re-running the setup rotates the password and converges on the same grants", async () => {
      await setUpRole(pg, role, "q".repeat(32));
      await pg.exec(`SET ROLE ${role.name}`);
      await expect(pg.query("SELECT count(*) FROM jobs")).resolves.toBeDefined();
      await expect(pg.query("SELECT count(*) FROM user_profiles")).rejects.toThrow(
        /permission denied/,
      );
    });

    // A setting already defined in the session reads back as '' once reverted; that must not clear the password.
    it("setup aborts when no password was bound", async () => {
      await expect(setUpRole(pg, role, "")).rejects.toThrow(
        /bind a password of at least 32 characters/,
      );
    });

    it.each(["SELECT", "SELECT (email)", "MAINTAIN"])(
      "setup aborts, changing nothing, when the role holds a privilege another role granted (%s)",
      async (grant) => {
        // The owner's REVOKE ALL removes only the owner's own grants; this one has another grantor.
        await pg.exec(`
          CREATE ROLE other_admin;
          GRANT ${grant} ON "user" TO other_admin WITH GRANT OPTION;
          SET ROLE other_admin;
          GRANT ${grant} ON "user" TO ${role.name};
          RESET ROLE;
        `);
        try {
          await expect(setUpRole(pg, role, "q".repeat(32))).rejects.toThrow(
            new RegExp(`${role.name} holds privileges beyond its allowlist \\(on: user;`),
          );
        } finally {
          await pg.exec(`
            SET ROLE other_admin;
            REVOKE ${grant} ON "user" FROM ${role.name};
            RESET ROLE;
            REVOKE ${grant} ON "user" FROM other_admin;
            DROP ROLE other_admin;
          `);
        }
      },
    );
  },
);
