import type { PGlite } from "@electric-sql/pglite";
import { getTableName } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";

import { setUpRole } from "@test/db/role";
import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";

import { BACKUP_TABLES, backupRunSql, newestBackupSql, rowCountsSql, truncateSql } from "./backup";
import { evaluateHealth, gatherHealthSignals } from "./health";
import { USER_BACKUP } from "./roles";
import { session, sourceRuns, user } from "./schema";

// What the user_backup role can do on real Postgres semantics, and the backup record the health check reads.
// The table-level confinement shared by every limited role is roles.integration.test.ts; the dump and restore
// themselves need pg_dump / pg_restore / psql and run in the backup workflow and the restore drill.

const SERIAL_SEQUENCES = [
  "user_cv_files_id_seq",
  "user_profiles_id_seq",
  "user_preferences_id_seq",
  "digest_runs_id_seq",
  "digests_id_seq",
  "digest_items_id_seq",
];

describe("user_backup role (integration: real PGlite semantics)", () => {
  let pg: PGlite;
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, client: pg, close } = await createTestDb());
    await setUpRole(pg, USER_BACKUP);
  });
  beforeEach(async () => {
    await truncate(db, sourceRuns);
  });
  afterEach(async () => {
    await pg.exec("RESET ROLE");
  });
  afterAll(async () => {
    await close?.();
  });

  it("reads every serial sequence of the backed-up tables (pg_dump needs it) but can't advance one", async () => {
    const { rows } = await pg.query<{ seq: string; can_read: boolean; can_advance: boolean }>(
      `SELECT c.relname AS seq,
              has_sequence_privilege('user_backup', c.oid, 'SELECT') AS can_read,
              has_sequence_privilege('user_backup', c.oid, 'USAGE, UPDATE') AS can_advance
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'S' AND n.nspname = 'public' ORDER BY c.relname`,
    );
    const readable = rows.filter((r) => r.can_read).map((r) => r.seq);
    expect(readable.sort()).toEqual([...SERIAL_SEQUENCES].sort());
    // The one sequence it may advance is source_runs' own, for the backup record's id.
    expect(rows.filter((r) => r.can_advance).map((r) => r.seq)).toEqual(["source_runs_id_seq"]);
  });

  it("counts every backed-up table and records a backup, but can't read or change source_runs", async () => {
    await pg.exec("SET ROLE user_backup");
    const counts = await pg.query<{ json_build_object: Record<string, number> }>(rowCountsSql());
    expect(Object.keys(counts.rows[0]!.json_build_object)).toEqual(
      BACKUP_TABLES.map((t) => getTableName(t)),
    );
    await pg.exec(backupRunSql(new Date("2026-10-27T04:05:00Z"), { tables: 8, bytes: 30180 }));
    await expect(pg.query("SELECT count(*) FROM source_runs")).rejects.toThrow(/permission denied/);
    await expect(pg.query("UPDATE source_runs SET status = 'error'")).rejects.toThrow(
      /permission denied/,
    );
    await expect(pg.query(`DELETE FROM "user"`)).rejects.toThrow(/permission denied/);
    await pg.exec("RESET ROLE");

    const recorded = await db.select().from(sourceRuns);
    expect(recorded).toMatchObject([
      { pipeline: "backup", status: "ok", source: null, counts: { tables: 8, bytes: 30180 } },
    ]);
    expect(recorded[0]!.startedAt).toEqual(new Date("2026-10-27T04:05:00Z"));
  });

  it("finds the newest successful backup for the restore", async () => {
    await db.insert(sourceRuns).values([
      {
        pipeline: "backup",
        status: "ok",
        startedAt: new Date("2026-10-25T04:05:00Z"),
        finishedAt: new Date("2026-10-25T04:06:00Z"),
      },
      {
        pipeline: "backup",
        status: "ok",
        startedAt: new Date("2026-10-26T04:05:00Z"),
        finishedAt: new Date("2026-10-26T04:06:00Z"),
      },
      {
        pipeline: "backup",
        status: "error",
        startedAt: new Date("2026-10-27T04:05:00Z"),
        finishedAt: new Date("2026-10-27T04:06:00Z"),
      },
      {
        pipeline: "ingestion",
        status: "ok",
        startedAt: new Date("2026-10-27T06:00:00Z"),
        finishedAt: new Date("2026-10-27T06:09:00Z"),
      },
    ]);
    const { rows } = await pg.query<{ to_json: string }>(newestBackupSql());
    expect(new Date(rows[0]!.to_json)).toEqual(new Date("2026-10-26T04:05:00Z"));
  });

  it("empties the backed-up tables and session for a restore (the restore database's owner runs it)", async () => {
    const [row] = await db
      .insert(user)
      .values({ name: "A", email: "a@example.test" })
      .returning({ id: user.id });
    await db.insert(session).values({ expiresAt: new Date(), token: "t", userId: row!.id });
    await pg.exec(truncateSql());
    const counts = await pg.query<{ json_build_object: Record<string, number> }>(rowCountsSql());
    expect(Object.values(counts.rows[0]!.json_build_object)).toEqual(BACKUP_TABLES.map(() => 0));
    expect(await db.select().from(session)).toEqual([]);
  });

  it("fails instead of emptying a table it doesn't name that points into the dump", async () => {
    await pg.exec(`CREATE TABLE stray (user_id uuid REFERENCES "user"(id))`);
    try {
      await expect(pg.exec(truncateSql())).rejects.toThrow(/cannot truncate a table referenced/);
    } finally {
      await pg.exec("DROP TABLE stray");
    }
  });
});

describe("backup_staleness (integration: real PGlite)", () => {
  let pg: PGlite;
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, client: pg, close } = await createTestDb());
    await setUpRole(pg, USER_BACKUP);
  });
  beforeEach(async () => {
    await truncate(db, sourceRuns);
  });
  afterAll(async () => {
    await close?.();
  });

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
  const backupCheck = async () =>
    evaluateHealth(await gatherHealthSignals(db)).checks.find((c) => c.id === "backup_staleness")!;

  it("flags a stale backup: the newest ok backup finished 30 h ago", async () => {
    await db.insert(sourceRuns).values([
      { pipeline: "backup", status: "ok", startedAt: hoursAgo(54.1), finishedAt: hoursAgo(54) },
      { pipeline: "backup", status: "ok", startedAt: hoursAgo(30.1), finishedAt: hoursAgo(30) },
      // Neither a failed backup nor another pipeline's run counts as a backup.
      { pipeline: "backup", status: "error", startedAt: hoursAgo(6.1), finishedAt: hoursAgo(6) },
      { pipeline: "ingestion", status: "ok", startedAt: hoursAgo(1.1), finishedAt: hoursAgo(1) },
    ]);
    const check = await backupCheck();
    expect(check).toMatchObject({ state: "firing", threshold: 26, mode: "shadow" });
    expect(check.metric).toBeCloseTo(30, 1);
  });

  it("fires with no data before the first backup is recorded", async () => {
    expect(await backupCheck()).toMatchObject({ state: "firing", metric: null });
  });

  it("is ok right after the role records a backup", async () => {
    await pg.exec("SET ROLE user_backup");
    await pg.exec(backupRunSql(hoursAgo(0.05), { tables: 8, bytes: 1 }));
    await pg.exec("RESET ROLE");
    const check = await backupCheck();
    expect(check.state).toBe("ok");
    expect(check.metric).toBeLessThan(0.1);
  });
});
