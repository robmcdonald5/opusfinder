import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import { companies, dataFixes, jobs } from "@opusfinder/db/schema";

import { pgliteFixClient } from "@test/db/fix-client";
import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";

import { buildDataFixerSetupSql, DATA_FIXER_ROLE, DATA_FIXER_TABLES } from "./fixer-role";
import { applyPendingFixes, fixSha256, type FixClient, type FixFile } from "./fixes";

// The data-fix runner and the data_fixer role under REAL Postgres semantics, run AS that role (what the GitHub
// Action uses): the setup SQL confines the role to the ingestion tables; the runner applies pending fixes in
// order, each in one transaction with its data_fixes record, exactly once, and stops at the first failure.
// Uses small synthetic fixes; each committed fix gets its own suite (e.g. fix-0001.integration.test.ts). NOT
// this file's job: the lint / numbering rules (fixes.test.ts) or the neon-serverless wire adapter
// (scripts/apply-fixes.ts, a thin shim over the same FixClient surface as @test/db/fix-client).

const PREVIEW = "/* preview\nSELECT 1;\n*/\n";

function fix(id: number, slug: string, apply: string): FixFile {
  const sql = `${PREVIEW}${apply}`;
  return { id, name: `${String(id).padStart(4, "0")}-${slug}.sql`, sql, sha256: fixSha256(sql) };
}

const deactivateAcme = fix(
  1,
  "deactivate-acme",
  `DO $$
DECLARE n int;
BEGIN
  UPDATE companies SET active = false, updated_at = now() WHERE id = 1 AND active;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'deactivated % row', n;
END $$;`,
);
const tagGlobex = fix(
  2,
  "tag-globex",
  `UPDATE companies SET metadata = '{"note": "fixed"}' WHERE id = 2;
DO $$ BEGIN RAISE NOTICE 'tagged'; END $$;`,
);

describe("data fixes: applied once, atomically, as the data_fixer role (integration: real PGlite semantics)", () => {
  let db: Db;
  let pg: PGlite;
  let close: (() => Promise<void>) | undefined;
  let fixer: FixClient;

  async function companyState(): Promise<{ id: number; active: boolean; metadata: unknown }[]> {
    return (
      await pg.query<{ id: number; active: boolean; metadata: unknown }>(
        "SELECT id, active, metadata FROM companies ORDER BY id",
      )
    ).rows;
  }

  async function recordedIds(): Promise<number[]> {
    return (await pg.query<{ id: number }>("SELECT id FROM data_fixes ORDER BY id")).rows.map(
      (r) => r.id,
    );
  }

  beforeAll(async () => {
    ({ db, client: pg, close } = await createTestDb());
    await pg.exec(buildDataFixerSetupSql("p".repeat(32)));
    fixer = pgliteFixClient(pg);
  });

  beforeEach(async () => {
    await pg.exec("RESET ROLE");
    await truncate(db, jobs, companies, dataFixes);
    await pg.exec(`
      INSERT INTO companies (id, slug, source) VALUES (1, 'acme', 'greenhouse'), (2, 'globex', 'lever');
      SET ROLE ${DATA_FIXER_ROLE};
    `);
  });

  afterAll(async () => {
    await close?.();
  });

  it("grants data_fixer only the ingestion tables (+ SELECT/INSERT on data_fixes) and no DDL", async () => {
    const privs = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
    // pg_tables, not information_schema.tables: the latter lists only tables the CURRENT role (data_fixer
    // here) can access, which would make this check vacuous.
    const { rows } = await pg.query<{ table_name: string; privs: string }>(`
      SELECT tablename AS table_name,
             concat_ws(',', ${privs
               .map(
                 (p) =>
                   `CASE WHEN has_table_privilege('${DATA_FIXER_ROLE}', format('%I.%I', schemaname, tablename), '${p}') THEN '${p}' END`,
               )
               .join(", ")}) AS privs
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename`);
    const actual = Object.fromEntries(rows.map((r) => [r.table_name, r.privs]));
    const expected = Object.fromEntries(
      rows.map((r) => [
        r.table_name,
        DATA_FIXER_TABLES.includes(r.table_name)
          ? "SELECT,INSERT,UPDATE,DELETE"
          : r.table_name === "data_fixes"
            ? "SELECT,INSERT"
            : "",
      ]),
    );
    expect(actual).toEqual(expected);
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

    const role = await pg.query<Record<string, boolean>>(`
      SELECT r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication AS elevated,
             EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS member_of_any,
             has_schema_privilege(r.rolname, 'public', 'CREATE') AS can_create
      FROM pg_roles r WHERE r.rolname = '${DATA_FIXER_ROLE}'`);
    expect(role.rows).toEqual([{ elevated: false, member_of_any: false, can_create: false }]);
    await expect(pg.query("SELECT count(*) FROM session")).rejects.toThrow(/permission denied/);
    await expect(pg.exec("CREATE TABLE sneaky (a int)")).rejects.toThrow(/permission denied/);
  });

  it("re-running the setup rotates the password and converges on the same grants", async () => {
    await pg.exec(
      `RESET ROLE; ${buildDataFixerSetupSql("q".repeat(32))} SET ROLE ${DATA_FIXER_ROLE};`,
    );
    await expect(pg.query("SELECT count(*) FROM jobs")).resolves.toBeDefined();
    await expect(pg.query("SELECT count(*) FROM user_profiles")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("setup aborts, changing nothing, when the role holds a privilege another role granted", async () => {
    // The owner's REVOKE ALL removes only the owner's own grants; this one has another grantor.
    await pg.exec(`
      RESET ROLE;
      CREATE ROLE other_admin;
      GRANT SELECT ON "user" TO other_admin WITH GRANT OPTION;
      SET ROLE other_admin;
      GRANT SELECT ON "user" TO ${DATA_FIXER_ROLE};
      RESET ROLE;
    `);
    try {
      await expect(pg.exec(buildDataFixerSetupSql("q".repeat(32)))).rejects.toThrow(
        /data_fixer holds privileges beyond its allowlist \(on: user;/,
      );
    } finally {
      await pg.exec(`
        REVOKE SELECT ON "user" FROM other_admin CASCADE;
        DROP ROLE other_admin;
        SET ROLE ${DATA_FIXER_ROLE};
      `);
    }
  });

  it("applies pending fixes in order, records each with the git sha, and returns their notices", async () => {
    const run = await applyPendingFixes(fixer, [deactivateAcme, tagGlobex], "abc123");

    expect(run).toEqual({
      alreadyApplied: 0,
      outcomes: [
        { fix: deactivateAcme, notices: ["deactivated 1 row"] },
        { fix: tagGlobex, notices: ["tagged"] },
      ],
    });
    expect(await companyState()).toEqual([
      { id: 1, active: false, metadata: null },
      { id: 2, active: true, metadata: { note: "fixed" } },
    ]);
    const records = await pg.query("SELECT id, name, sha256, git_sha FROM data_fixes ORDER BY id");
    expect(records.rows).toEqual([
      { id: 1, name: deactivateAcme.name, sha256: deactivateAcme.sha256, git_sha: "abc123" },
      { id: 2, name: tagGlobex.name, sha256: tagGlobex.sha256, git_sha: "abc123" },
    ]);
  });

  it("skips fixes already recorded and applies only the new ones", async () => {
    await applyPendingFixes(fixer, [deactivateAcme], null);
    await pg.exec("UPDATE companies SET active = true WHERE id = 1"); // would show a second apply

    const run = await applyPendingFixes(fixer, [deactivateAcme, tagGlobex], null);

    expect(run).toEqual({ alreadyApplied: 1, outcomes: [{ fix: tagGlobex, notices: ["tagged"] }] });
    expect((await companyState())[0]!.active).toBe(true);
    expect(await applyPendingFixes(fixer, [deactivateAcme, tagGlobex], null)).toEqual({
      alreadyApplied: 2,
      outcomes: [],
    });
  });

  it("stops at the first failing fix: it rolls back with its notices reported, later fixes never run", async () => {
    const trips = fix(
      2,
      "trips-a-guard",
      `UPDATE companies SET metadata = '{"half": "done"}' WHERE id = 2;
DO $$ BEGIN RAISE NOTICE 'about to trip'; RAISE EXCEPTION 'guard tripped'; END $$;`,
    );
    const later = { ...tagGlobex, id: 3, name: "0003-tag-globex.sql" };

    const run = await applyPendingFixes(fixer, [deactivateAcme, trips, later], null);

    expect(run.outcomes.map((o) => [o.fix.id, o.notices, o.error])).toEqual([
      [1, ["deactivated 1 row"], undefined],
      [2, ["about to trip"], "guard tripped"],
    ]);
    expect(await companyState()).toEqual([
      { id: 1, active: false, metadata: null }, // fix 1 committed before fix 2 failed
      { id: 2, active: true, metadata: null }, // fix 2's first statement rolled back; fix 3 never ran
    ]);
    expect(await recordedIds()).toEqual([1]);
  });

  it("applies a fix and its record atomically: a failing record insert undoes the fix", async () => {
    // The fix itself claims id 1, so the runner's own record insert (a separate statement) hits the primary key.
    const squatter = fix(
      1,
      "claims-its-own-record",
      `UPDATE companies SET active = false WHERE id = 2;
INSERT INTO data_fixes (id, name, sha256) VALUES (1, 'squatter', 'y');`,
    );

    const run = await applyPendingFixes(fixer, [squatter], null);

    expect(run.outcomes[0]!.error).toMatch(/duplicate key/);
    expect((await companyState())[1]!.active).toBe(true);
    expect(await recordedIds()).toEqual([]);
  });

  it("reports a failure AT COMMIT as unconfirmed, since the fix may have committed", async () => {
    // The server commits, then the connection drops before the client hears back.
    const dropsAtCommit: FixClient = {
      async query(sql, params) {
        const rows = await fixer.query(sql, params);
        if (sql === "COMMIT") throw new Error("connection lost");
        return rows;
      },
      takeNotices: () => fixer.takeNotices(),
    };

    const run = await applyPendingFixes(dropsAtCommit, [deactivateAcme], null);

    expect(run.outcomes).toEqual([
      {
        fix: deactivateAcme,
        notices: ["deactivated 1 row"],
        error: "connection lost",
        unconfirmed: true,
      },
    ]);
    expect(await recordedIds()).toEqual([1]);
  });

  it("refuses to run anything when an applied fix's file is gone", async () => {
    await applyPendingFixes(fixer, [deactivateAcme], null);

    await expect(applyPendingFixes(fixer, [tagGlobex], null)).rejects.toThrow(
      /applied fix files are missing: 0001-deactivate-acme\.sql/,
    );
    expect((await companyState())[1]!.metadata).toBeNull();
  });

  it("refuses to run anything when an applied fix's file has changed since", async () => {
    await pg.query("INSERT INTO data_fixes (id, name, sha256) VALUES (1, $1, 'deadbeef')", [
      deactivateAcme.name,
    ]);

    await expect(applyPendingFixes(fixer, [deactivateAcme, tagGlobex], null)).rejects.toThrow(
      /0001-deactivate-acme\.sql changed after it was applied/,
    );
    expect(await companyState()).toEqual([
      { id: 1, active: true, metadata: null },
      { id: 2, active: true, metadata: null },
    ]);
  });
});
