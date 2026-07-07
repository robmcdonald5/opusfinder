import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  deactivateStale,
  listCompaniesForReprobe,
  listCompanyStates,
  markProbed,
  markProbeResult,
} from "@opusfinder/db/repos";
import { companies } from "@opusfinder/db/schema";
import { companySlug, type CompanySlug, type SourceName } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";

// What this file proves: the companies-lifecycle field semantics in repos/discovery.ts that runDiscovery
// drives but cannot cleanly observe through the orchestrator (every write is interleaved with the run's
// other writes there). These are the sibling to profiles.integration.test.ts — the repo owns the exact
// branchless-SET matrix (a LIVE probe reactivates + resets the streak + refreshes the staleness clock; a
// FAILED probe increments the streak but must NOT touch last_live_at/active; markProbed advances ONLY the
// probe cursor), the multi-clause deactivateStale guard (active AND streak>0 AND stale clock, COALESCE
// falling back to created_at), and the oldest-probed-first reprobe queue (NULLS FIRST + id tiebreak).
// NOT this file's job: the run-row lifecycle (runs.integration.test.ts owns startRun/finishRun/
// failStaleRuns) and the runDiscovery orchestration wiring (discover.integration.test.ts).

// Sentinel timestamp planted via the explicit insert — DB now() cannot be faked, so exact-preservation
// ("this column was NOT touched") and strict-advancement ("this column WAS stamped now()") assertions
// hang off it instead of comparing two now() values.
const SENTINEL_2020 = new Date("2020-01-01T00:00:00Z");
const DAY_MS = 86_400_000;
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS);
}

interface CompanySeed {
  /** Explicit serial id, to decouple heap/insert order from id order in ordering tests. */
  id?: number;
  slug: string;
  source?: SourceName;
  active?: boolean;
  consecutiveProbeFailures?: number;
  lastLiveAt?: Date | null;
  lastProbedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

describe("discovery repo — companies lifecycle field semantics (integration: real PGlite Postgres)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    // Truncate ONLY the table this file touches; RESTART IDENTITY keeps serial ids deterministic.
    await db.execute(sql`TRUNCATE TABLE companies RESTART IDENTITY CASCADE`);
  });
  afterAll(async () => {
    // Optional-chained: if beforeAll's createTestDb() rejected, a bare close() would bury the real
    // failure under a secondary TypeError. Drains the WASM handle → clean Windows teardown.
    await close?.();
  });

  async function seedCompany(seed: CompanySeed): Promise<number> {
    const rows = await db
      .insert(companies)
      .values({
        id: seed.id,
        slug: companySlug(seed.slug),
        source: seed.source ?? "greenhouse",
        // `undefined` lets drizzle omit the column so the schema default applies (active→true, streak→0).
        active: seed.active,
        consecutiveProbeFailures: seed.consecutiveProbeFailures,
        lastLiveAt: seed.lastLiveAt,
        lastProbedAt: seed.lastProbedAt,
        createdAt: seed.createdAt,
        updatedAt: seed.updatedAt,
      })
      .returning({ id: companies.id });
    const row = rows[0];
    if (!row) throw new Error("seedCompany returned no row");
    return row.id;
  }

  async function readCompany(id: number) {
    const rows = await db.select().from(companies).where(eq(companies.id, id));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  describe("markProbeResult — the branchless live/failed SET matrix", () => {
    it("a LIVE probe reactivates an inactive failing row: streak→0, last_live_at + last_probed_at + updated_at stamped now()", async () => {
      // A dead-then-revived slug: inactive, a real failure streak, and stale live/probe/updated clocks.
      const id = await seedCompany({
        slug: "revived",
        active: false,
        consecutiveProbeFailures: 2,
        lastLiveAt: SENTINEL_2020,
        lastProbedAt: SENTINEL_2020,
        updatedAt: SENTINEL_2020,
      });
      // Bystander with identical sentinels: the eq(id) scope must leave it byte-identical.
      const bystander = await seedCompany({
        slug: "bystander",
        active: false,
        consecutiveProbeFailures: 2,
        lastLiveAt: SENTINEL_2020,
        lastProbedAt: SENTINEL_2020,
        updatedAt: SENTINEL_2020,
      });
      const bystanderBefore = await readCompany(bystander);

      await markProbeResult(db, id, true);

      const row = await readCompany(id);
      expect(row.active).toBe(true); // dropping `active: true` from the live spread leaves it false
      expect(row.consecutiveProbeFailures).toBe(0); // a `+1`/kept-streak mutation leaves 2
      // The staleness clock + probe cursor + row clock all move off 2020 — each is an independent SET member.
      expect(row.lastLiveAt!.getTime()).toBeGreaterThan(SENTINEL_2020.getTime());
      expect(row.lastProbedAt!.getTime()).toBeGreaterThan(SENTINEL_2020.getTime());
      expect(row.updatedAt.getTime()).toBeGreaterThan(SENTINEL_2020.getTime());
      // Scope: any write landing on the bystander means the eq(id) predicate was dropped.
      expect(await readCompany(bystander)).toEqual(bystanderBefore);
    });

    it("a FAILED probe increments the streak + advances last_probed_at but LEAVES last_live_at and active untouched", async () => {
      const id = await seedCompany({
        slug: "failing",
        active: true,
        consecutiveProbeFailures: 1,
        lastLiveAt: SENTINEL_2020,
        lastProbedAt: SENTINEL_2020,
        updatedAt: SENTINEL_2020,
      });
      const bystander = await seedCompany({
        slug: "bystander",
        active: true,
        consecutiveProbeFailures: 1,
        lastLiveAt: SENTINEL_2020,
        lastProbedAt: SENTINEL_2020,
        updatedAt: SENTINEL_2020,
      });
      const bystanderBefore = await readCompany(bystander);

      await markProbeResult(db, id, false);

      const row = await readCompany(id);
      expect(row.consecutiveProbeFailures).toBe(2); // SQL-side `failures + 1`: a reset-to-0 mutation flips this
      // The staleness clock is UNTOUCHED on a failed probe — this is what keeps deactivateStale's window
      // counting. If the live-only `{ lastLiveAt, active }` spread leaked onto the failed path, this would
      // advance off 2020 (masking a dead board as recently-live and never deactivating it).
      expect(row.lastLiveAt).toEqual(SENTINEL_2020);
      expect(row.active).toBe(true); // failed never deactivates here (that is deactivateStale's job)
      // Every probe still stamps the cursor + row clock.
      expect(row.lastProbedAt!.getTime()).toBeGreaterThan(SENTINEL_2020.getTime());
      expect(row.updatedAt.getTime()).toBeGreaterThan(SENTINEL_2020.getTime());
      expect(await readCompany(bystander)).toEqual(bystanderBefore);
    });
  });

  describe("markProbed — advances ONLY the probe cursor (the inconclusive stamp)", () => {
    it("stamps last_probed_at + updated_at but never touches the streak, last_live_at, or active", async () => {
      // Seed active:false + a non-zero streak + a live clock so any leaked SET member is observable:
      // a streak reset would zero 3, an added `active: true` would flip false→true, an added lastLiveAt
      // would move 2020. markProbed must move ONLY last_probed_at (and updated_at).
      const id = await seedCompany({
        slug: "inconclusive",
        active: false,
        consecutiveProbeFailures: 3,
        lastLiveAt: SENTINEL_2020,
        lastProbedAt: SENTINEL_2020,
        updatedAt: SENTINEL_2020,
      });
      const bystander = await seedCompany({
        slug: "bystander",
        active: false,
        consecutiveProbeFailures: 3,
        lastLiveAt: SENTINEL_2020,
        lastProbedAt: SENTINEL_2020,
        updatedAt: SENTINEL_2020,
      });
      const bystanderBefore = await readCompany(bystander);

      await markProbed(db, id);

      const row = await readCompany(id);
      expect(row.lastProbedAt!.getTime()).toBeGreaterThan(SENTINEL_2020.getTime());
      expect(row.updatedAt.getTime()).toBeGreaterThan(SENTINEL_2020.getTime());
      // The three columns markProbed must leave alone — the whole point of it existing next to markProbeResult.
      expect(row.consecutiveProbeFailures).toBe(3);
      expect(row.lastLiveAt).toEqual(SENTINEL_2020);
      expect(row.active).toBe(false);
      expect(await readCompany(bystander)).toEqual(bystanderBefore);
    });
  });

  describe("deactivateStale — the multi-clause staleness guard", () => {
    it("sweeps only ACTIVE, non-zero-streak, past-window rows (COALESCE(last_live_at, created_at)); returns their ids; leaves every other class untouched", async () => {
      // SWEPT: active, streak>0, last_live_at 40d ago (past the 30d default window).
      const swept = await seedCompany({
        slug: "swept",
        active: true,
        consecutiveProbeFailures: 1,
        lastLiveAt: daysAgo(40),
        updatedAt: SENTINEL_2020, // planted past clock → deactivateStale's `updated_at = now()` write is provable
      });
      // SWEPT via the COALESCE fallback: last_live_at NULL (never LIVE-probed), created_at 40d ago.
      const sweptByCreated = await seedCompany({
        slug: "swept-created",
        active: true,
        consecutiveProbeFailures: 1,
        lastLiveAt: null,
        createdAt: daysAgo(40),
      });
      // SPARED — never-failed (streak 0): drops the `consecutive_probe_failures > 0` clause if it leaks in.
      const neverFailed = await seedCompany({
        slug: "never-failed",
        active: true,
        consecutiveProbeFailures: 0,
        lastLiveAt: daysAgo(40),
      });
      // SPARED — recent (10d ago, inside the window): drops the staleness clock clause if it leaks in.
      const recent = await seedCompany({
        slug: "recent",
        active: true,
        consecutiveProbeFailures: 1,
        lastLiveAt: daysAgo(10),
      });
      // SPARED — already inactive: drops the `active = true` clause if it leaks in (and would be RETURNED).
      const alreadyInactive = await seedCompany({
        slug: "already-inactive",
        active: false,
        consecutiveProbeFailures: 5,
        lastLiveAt: daysAgo(40),
      });

      // No explicit days arg → exercises the `olderThanDays = 30` default parameter.
      const ids = await deactivateStale(db);

      // Exactly the two qualifying rows come back — any dropped clause pulls a spared row into this set.
      expect([...ids].sort((a, b) => a - b)).toEqual([swept, sweptByCreated].sort((a, b) => a - b));
      expect((await readCompany(swept)).active).toBe(false);
      expect((await readCompany(sweptByCreated)).active).toBe(false);
      // updated_at WAS stamped now() on the swept row: seeded at SENTINEL_2020 (which is NOT part of the
      // COALESCE(last_live_at, created_at) staleness predicate, so it cannot change qualification), so a
      // dropped `updatedAt: sql`now()`` SET member is caught here — matching the markProbeResult/markProbed siblings.
      expect((await readCompany(swept)).updatedAt.getTime()).toBeGreaterThan(SENTINEL_2020.getTime());
      // The spared rows keep their pre-sweep active flag.
      expect((await readCompany(neverFailed)).active).toBe(true);
      expect((await readCompany(recent)).active).toBe(true);
      expect((await readCompany(alreadyInactive)).active).toBe(false);
    });

    it("scopes the sweep to opts.source — a qualifying row on another source is left active", async () => {
      const gh = await seedCompany({
        slug: "gh-stale",
        source: "greenhouse",
        active: true,
        consecutiveProbeFailures: 1,
        lastLiveAt: daysAgo(40),
      });
      // Identical staleness on lever: qualifies on every clause EXCEPT the source filter.
      const lever = await seedCompany({
        slug: "lever-stale",
        source: "lever",
        active: true,
        consecutiveProbeFailures: 1,
        lastLiveAt: daysAgo(40),
      });

      const ids = await deactivateStale(db, 30, { source: "greenhouse" });

      expect(ids).toEqual([gh]); // lever leaking in = the eq(source) condition was dropped
      expect((await readCompany(gh)).active).toBe(false);
      expect((await readCompany(lever)).active).toBe(true);
    });
  });

  describe("listCompaniesForReprobe — the oldest-probed-first ACTIVE queue", () => {
    it("returns ACTIVE rows ordered last_probed_at ASC NULLS FIRST then id, honoring limit and source", async () => {
      // EXPLICIT ids INVERT insert order within each equal-last_probed_at tie group, so BOTH sort keys are
      // load-bearing under PGlite's seqscan: the primary key (last_probed ASC NULLS FIRST) is caught by the
      // heap≠expected layout, AND the `, companies.id` tiebreak is caught because within a tie group the
      // expected id-ascending order differs from the heap/insert order — dropping the id tiebreak returns
      // heap order and mismatches.
      const D2020 = new Date("2020-06-01T00:00:00Z");
      const D2021 = new Date("2021-01-01T00:00:00Z");
      // null (NULLS FIRST) group — expected id-asc [40, 60, 70(lever)]; null60 is inserted BEFORE null40.
      const null60 = await seedCompany({ id: 60, slug: "null-b", lastProbedAt: null });
      const null40 = await seedCompany({ id: 40, slug: "null-a", lastProbedAt: null });
      // 2020-06-01 tie group — expected id-asc [20, 30]; tie30 is inserted BEFORE tie20.
      const tie30 = await seedCompany({ id: 30, slug: "tie-b", lastProbedAt: D2020 });
      const tie20 = await seedCompany({ id: 20, slug: "tie-a", lastProbedAt: D2020 });
      const probed2021 = await seedCompany({ id: 10, slug: "p-2021", lastProbedAt: D2021 });
      // Excluded: inactive (active filter) and lever (source scope below); lever is ALSO in the null group.
      const inactive = await seedCompany({ id: 50, slug: "inactive", active: false, lastProbedAt: null });
      const lever = await seedCompany({ id: 70, slug: "lever", source: "lever", lastProbedAt: null });

      const all = await listCompaniesForReprobe(db, { limit: 10 });
      // NULLS FIRST head (id-asc: 40, 60, 70), then 2020-06-01 (id-asc: 20, 30), then 2021 (10). Each tie
      // group's id order != its heap order, so this pins the id tiebreak. inactive (id 50) is absent.
      expect(all.map((r) => r.id)).toEqual([null40, null60, lever, tie20, tie30, probed2021]);
      // The projection is {id, slug, source} — no `active` column leaks through.
      expect(Object.keys(all[0]!).sort()).toEqual(["id", "slug", "source"]);
      expect(all.every((r) => r.id !== inactive)).toBe(true);

      // limit truncates the oldest-first head (the first 3 by the full ordering).
      const limited = await listCompaniesForReprobe(db, { limit: 3 });
      expect(limited.map((r) => r.id)).toEqual([null40, null60, lever]);

      // source scope drops the lever row (id 70) from the null head.
      const scoped = await listCompaniesForReprobe(db, { source: "greenhouse", limit: 10 });
      expect(scoped.map((r) => r.id)).toEqual([null40, null60, tie20, tie30, probed2021]);
    });
  });

  describe("listCompanyStates — every row's (id, slug, source, active) for the partition", () => {
    it("returns all rows including inactive ones with the correct active flag, optionally source-scoped", async () => {
      const active = await seedCompany({ slug: "active-co", active: true });
      const inactive = await seedCompany({ slug: "inactive-co", active: false });
      const lever = await seedCompany({ slug: "lever-co", source: "lever", active: true });

      const states = await listCompanyStates(db);
      const byId = new Map(states.map((s) => [s.id, s]));
      // Unlike listCompaniesForReprobe, this INCLUDES inactive rows (the partition must see them to route
      // KNOWN-INACTIVE candidates back to the probe path).
      expect(byId.get(inactive)?.active).toBe(false); // a hardcoded `active: true` projection flips this
      expect(byId.get(active)?.active).toBe(true);
      expect(byId.get(lever)?.active).toBe(true);
      expect((byId.get(active) as { slug: CompanySlug }).slug).toBe("active-co");
      expect((byId.get(active) as { source: SourceName }).source).toBe("greenhouse");

      const scoped = await listCompanyStates(db, { source: "greenhouse" });
      // lever leaking in = the eq(source) filter was dropped.
      expect(scoped.map((s) => s.id).sort((a, b) => a - b)).toEqual(
        [active, inactive].sort((a, b) => a - b),
      );
    });
  });
});
