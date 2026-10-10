import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import { companies, COMPANIES_LOWER_SLUG_UQ, dataFixes, jobs } from "@opusfinder/db/schema";

import { pgliteFixClient } from "@test/db/fix-client";
import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";

import { buildDataFixerSetupSql, DATA_FIXER_ROLE } from "./fixer-role";
import { applyPendingFixes, fixSha256, readFixes, type FixClient, type FixFile } from "./fixes";

// The committed fix 0001 (merge the 7 case-variant duplicate boards) applied through the real runner AS the
// data_fixer role, against a seeded copy of the 14 company rows: proves the grants suffice, the merge moves
// every alias job and retires the alias (both `retire` modes), a re-run is a no-op, and each guard aborts the
// WHOLE fix. Runner semantics in general (ordering, once-only, record atomicity) are fixes.integration.test.ts.

// [source, kept id, kept slug, alias id, alias slug], as in the fix.
const PAIRS = [
  ["smartrecruiters", 1420, "BoschGroup", 624, "boschgroup"],
  ["smartrecruiters", 576, "K-group1", 601, "k-group1"],
  ["smartrecruiters", 1068, "McDonaldsCorporation", 1069, "mcdonaldscorporation"],
  ["smartrecruiters", 309, "TheMill2", 604, "themill2"],
  ["smartrecruiters", 10, "Visa", 806, "visa"],
  ["ashby", 1660, "Mapbox", 814, "mapbox"],
  ["ashby", 62710, "Solace", 1546, "solace"],
] as const;
const UNRELATED_ID = 5000;
const RETIRE_LINE = "retire constant text := 'delete';";

describe("fix 0001: merge the case-variant duplicate boards (integration: real PGlite semantics)", () => {
  let db: Db;
  let pg: PGlite;
  let close: (() => Promise<void>) | undefined;
  let fixer: FixClient;
  let fix0001: FixFile;

  /** Fix 0001 with its `retire` switch flipped to 'deactivate' (the committed default is 'delete'). */
  function deactivating(): FixFile {
    const sql = fix0001.sql.replace(RETIRE_LINE, "retire constant text := 'deactivate';");
    return { ...fix0001, sql, sha256: fixSha256(sql) };
  }

  async function jobCounts(): Promise<Map<number, number>> {
    const { rows } = await pg.query<{ company_id: number; n: number }>(
      "SELECT company_id, count(*)::int AS n FROM jobs GROUP BY company_id",
    );
    return new Map(rows.map((r) => [r.company_id, r.n]));
  }

  async function activeById(): Promise<Map<number, boolean>> {
    const { rows } = await pg.query<{ id: number; active: boolean }>(
      "SELECT id, active FROM companies",
    );
    return new Map(rows.map((r) => [r.id, r.active]));
  }

  beforeAll(async () => {
    ({ db, client: pg, close } = await createTestDb());
    // The fix ran BEFORE migration 0025, whose case-folded unique index forbids the duplicate pairs seeded
    // below: drop it to reproduce the database the fix was written for.
    await pg.exec(`DROP INDEX "${COMPANIES_LOWER_SLUG_UQ}"`);
    await pg.exec(buildDataFixerSetupSql("p".repeat(32)));
    fixer = pgliteFixClient(pg);
    fix0001 = readFixes().fixes.find((f) => f.id === 1)!;
  });

  // Every pair: the alias holds 2 jobs (one closed), the kept row 1; plus an unrelated board with 1 job.
  beforeEach(async () => {
    await pg.exec("RESET ROLE");
    await truncate(db, jobs, companies, dataFixes);
    const companyRows: string[] = [`(${UNRELATED_ID}, 'acme', 'greenhouse')`];
    const jobRows: string[] = [`('greenhouse', 'u-1', ${UNRELATED_ID}, 'active')`];
    for (const [source, keepId, keepSlug, aliasId, aliasSlug] of PAIRS) {
      companyRows.push(
        `(${keepId}, '${keepSlug}', '${source}')`,
        `(${aliasId}, '${aliasSlug}', '${source}')`,
      );
      jobRows.push(
        `('${source}', 'k-${keepId}', ${keepId}, 'active')`,
        `('${source}', 'a1-${aliasId}', ${aliasId}, 'active')`,
        `('${source}', 'a2-${aliasId}', ${aliasId}, 'closed')`,
      );
    }
    await pg.exec(`
      INSERT INTO companies (id, slug, source) VALUES ${companyRows.join(", ")};
      INSERT INTO jobs (source, external_id, company_id, lifecycle_state, title, remote, apply_url, updated_at)
      SELECT source, external_id, company_id, lifecycle_state, 'Engineer', false, 'https://example.com',
             '2026-01-01T00:00:00Z'
      FROM (VALUES ${jobRows.join(", ")}) AS v (source, external_id, company_id, lifecycle_state);
      SET ROLE ${DATA_FIXER_ROLE};
    `);
  });

  afterAll(async () => {
    await close?.();
  });

  it("ships with retire = 'delete' (the owner flips this one line to choose 'deactivate')", () => {
    expect(fix0001.sql).toContain(RETIRE_LINE);
  });

  it.each([
    ["delete", () => fix0001, "deleted", undefined],
    ["deactivate", () => deactivating(), "deactivated", false],
  ] as const)(
    "retire = %s: moves every alias's jobs to the kept row, retires the alias, reports each pair",
    async (_mode, getFix, verb, aliasActive) => {
      const run = await applyPendingFixes(fixer, [getFix()], "abc123");

      expect(run.outcomes).toHaveLength(1);
      expect(run.outcomes[0]!.error).toBeUndefined();
      expect(run.outcomes[0]!.notices).toEqual([
        ...PAIRS.map(
          ([source, keepId, keepSlug, aliasId, aliasSlug]) =>
            `${source} ${keepSlug}: kept row ${keepId}; alias row ${aliasId} (${aliasSlug}): 2 jobs moved, 1 row ${verb}`,
        ),
        "total: 14 jobs moved",
      ]);

      const counts = await jobCounts();
      const active = await activeById();
      for (const [, keepId, , aliasId] of PAIRS) {
        // kept: its 1 job + the alias's 2 (closed included), still active; alias: no jobs, gone or inactive.
        expect([
          counts.get(keepId),
          counts.get(aliasId),
          active.get(keepId),
          active.get(aliasId),
        ]).toEqual([3, undefined, true, aliasActive]);
      }
      expect([counts.get(UNRELATED_ID), active.get(UNRELATED_ID)]).toEqual([1, true]);
      // A moved job's updated_at advances (as ingest's own re-pointing does); an unrelated job's doesn't.
      const stamped = await pg.query<{ updated_at: Date }>(
        "SELECT updated_at FROM jobs WHERE external_id IN ('a1-624', 'u-1') ORDER BY external_id",
      );
      expect(
        stamped.rows.map((r) => r.updated_at.toISOString() === "2026-01-01T00:00:00.000Z"),
      ).toEqual([false, true]);
    },
  );

  it.each([
    [
      "delete",
      () => fix0001,
      "smartrecruiters BoschGroup: alias row 624 (boschgroup) already gone",
    ],
    [
      "deactivate",
      () => deactivating(),
      "smartrecruiters BoschGroup: kept row 1420; alias row 624 (boschgroup): 0 jobs moved, 0 row deactivated",
    ],
  ] as const)(
    "retire = %s: running the fix again changes nothing",
    async (_mode, getFix, notice) => {
      await applyPendingFixes(fixer, [getFix()], null);
      fixer.takeNotices();

      await fixer.query(getFix().sql); // bypasses the runner's once-only record on purpose

      const notices = fixer.takeNotices();
      expect(notices).toContain(notice);
      expect(notices).toContain("total: 0 jobs moved");
      expect((await jobCounts()).get(1420)).toBe(3);
    },
  );

  it.each([
    [
      "an alias row's slug changed",
      "UPDATE companies SET slug = 'mcdonalds' WHERE id = 1069",
      /alias row 1069 is now smartrecruiters mcdonalds/,
    ],
    [
      "a kept row is inactive",
      "UPDATE companies SET active = false WHERE id = 10",
      /kept row 10 .* missing, changed or inactive/,
    ],
    [
      "a third spelling of a board exists",
      "INSERT INTO companies (id, slug, source) VALUES (7000, 'MAPBOX', 'ashby')",
      /another ashby row spells Mapbox/,
    ],
    [
      "an alias holds another source's job",
      "UPDATE jobs SET source = 'lever' WHERE external_id = 'a1-814'",
      /alias row 814 has jobs from another source/,
    ],
  ])("aborts the whole fix when a guard trips: %s", async (_label, drift, error) => {
    await pg.exec(`RESET ROLE; ${drift}; SET ROLE ${DATA_FIXER_ROLE};`);

    const run = await applyPendingFixes(fixer, [fix0001], null);

    expect(run.outcomes[0]!.error).toMatch(error);
    // Pairs processed BEFORE the guard tripped were rolled back too: every job and alias is as seeded.
    const counts = await jobCounts();
    const active = await activeById();
    for (const [, keepId, , aliasId] of PAIRS) {
      expect([counts.get(keepId), counts.get(aliasId), active.get(aliasId)]).toEqual([1, 2, true]);
    }
    expect((await pg.query("SELECT * FROM data_fixes")).rows).toEqual([]);
  });
});
