import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@opusfinder/db";
import { companies, jobs, sourceRuns } from "@opusfinder/db/schema";
import { runDiscovery } from "@opusfinder/discovery";
import { companySlug, jobId, type SourceName } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";
import { jsonResponse, routedFetch, textResponse, type Route } from "@test/http/fetch-router";

// What this file proves: the runDiscovery ORCHESTRATION over real PGlite — the seed→resolve→PARTITION→
// probe→upsert→reprobe→deactivate→board-close pipeline, driven end-to-end with the global `fetch` stubbed
// (there is no injectable fetch seam; the stub shadows the integration MSW rig — see @test/http/fetch-router).
// Focus is the DB-observable wiring NO other suite owns: the partition (already-active excluded,
// KNOWN-INACTIVE re-probed → reactivated), the worklist `limit` slice, which probe outcomes WRITE (live/
// live-empty upsert; absent/indeterminate/transient never), the dryRun write-suppression, the reprobe pass
// (refresh/mark-failed/inconclusive + the exclude-just-upserted skip), the board-death close (shadow vs
// enforce), the olderThanDays≤0 coercion, and the source_runs row (ok + error). NOT this file's job: the
// probe fetch/classify/throttle internals (probe-*.test.ts), the seed resolve tallies (resolve/lanes unit
// suites), and the per-column companies-lifecycle SET matrix (db repos/discovery.integration.test.ts).

// Prober tuning that removes ALL real waits from the run: no retries (a 5xx/throw resolves on the first
// attempt, so no `backoff` setTimeout fires) and no host spacing (hostMinIntervalMs 0 → HostThrottle
// acquires immediately). The retry/backoff/throttle behavior is owned by the probe unit suites under fake
// timers; here they would only add wall-clock.
const PROBE_OPTS = {
  maxRetries: 0,
  hostMinIntervalMs: 0,
  hostConcurrency: 20,
  globalConcurrency: 20,
} as const;

const SENTINEL_2020 = new Date("2020-01-01T00:00:00Z");
const DAY_MS = 86_400_000;
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS);
}

// ── seed-lane + probe routing (greenhouse: one host, slug in the path) ─────────────────────────
// A seed record whose ats_link resolves (boards.greenhouse.io/{slug} → firstPathSegment) to a greenhouse
// candidate. The outscal lane fetches SEED_URL and expects a JSON array of these.
function seedRecords(slugs: string[]): { ats_links: string[] }[] {
  return slugs.map((s) => ({ ats_links: [`https://boards.greenhouse.io/${s}`] }));
}
const seedRoute = (slugs: string[]): Route => ({
  match: (url) => url.includes("companies_v2.json"),
  respond: () => jsonResponse(seedRecords(slugs)),
});
// greenhouse.jobsRequest → boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
const probeMatch = (slug: string) => (url: string) => url.includes(`/v1/boards/${slug}/jobs`);
const liveRoute = (slug: string): Route => ({
  match: probeMatch(slug),
  respond: () => jsonResponse({ jobs: [{ id: 1, title: "Engineer", absolute_url: `https://x/${slug}/1` }] }),
});
const emptyRoute = (slug: string): Route => ({
  match: probeMatch(slug),
  respond: () => jsonResponse({ jobs: [] }),
});
const absentRoute = (slug: string): Route => ({
  match: probeMatch(slug),
  respond: () => textResponse("Not Found", 404),
});
const indeterminateRoute = (slug: string): Route => ({
  // A final 500 (no retries) classifies from status alone → indeterminate (never drives a write).
  match: probeMatch(slug),
  respond: () => textResponse("busy", 500),
});
const transientRoute = (slug: string): Route => ({
  // A network throw (no retries) → probeFetch returns status 0 → transientFailed.
  match: probeMatch(slug),
  respond: () => {
    throw new Error("ECONNRESET");
  },
});

interface CompanySeed {
  slug: string;
  source?: SourceName;
  active?: boolean;
  consecutiveProbeFailures?: number;
  lastLiveAt?: Date | null;
  lastProbedAt?: Date | null;
  updatedAt?: Date;
  createdAt?: Date;
}

describe("runDiscovery — orchestration over real PGlite (fetch stubbed)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies, jobs, source_runs RESTART IDENTITY CASCADE`);
  });
  afterEach(() => {
    // Restore the MSW-patched global fetch each test installed over (config has no unstubGlobals:true).
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await close?.();
  });

  function installFetch(routes: Route[]) {
    const fx = routedFetch(routes);
    vi.stubGlobal("fetch", fx);
    return fx;
  }

  async function seedCompany(seed: CompanySeed): Promise<number> {
    const rows = await db
      .insert(companies)
      .values({
        slug: companySlug(seed.slug),
        source: seed.source ?? "greenhouse",
        active: seed.active,
        consecutiveProbeFailures: seed.consecutiveProbeFailures,
        lastLiveAt: seed.lastLiveAt,
        lastProbedAt: seed.lastProbedAt,
        updatedAt: seed.updatedAt,
        createdAt: seed.createdAt,
      })
      .returning({ id: companies.id });
    return rows[0]!.id;
  }

  async function seedJob(companyId: number, externalId: string): Promise<void> {
    await db.insert(jobs).values({
      externalId: jobId(externalId),
      companyId,
      source: "greenhouse",
      title: "seeded job",
      remote: false,
      applyUrl: "https://x/apply",
    });
  }

  async function companyBySlug(slug: string) {
    const rows = await db.select().from(companies).where(eq(companies.slug, companySlug(slug)));
    return rows[0];
  }
  async function jobsFor(companyId: number) {
    return db.select().from(jobs).where(eq(jobs.companyId, companyId));
  }
  async function allSourceRuns() {
    return db.select().from(sourceRuns);
  }

  describe("worklist pass — seed → probe → upsert", () => {
    it("probes every NEW candidate, upserts only live/live-empty, tallies each bucket, and terminalizes the run 'ok'", async () => {
      const fx = installFetch([
        seedRoute(["livco", "emptyco", "goneco", "indetco", "flakyco"]),
        liveRoute("livco"),
        emptyRoute("emptyco"),
        absentRoute("goneco"),
        indeterminateRoute("indetco"),
        transientRoute("flakyco"),
      ]);

      const counts = await runDiscovery(db, { lanes: ["outscal"], probe: PROBE_OPTS });

      // Every outcome bucket is distinct — a tally regression on any one flips exactly one number.
      expect(counts).toMatchObject({
        candidates: 5,
        alreadyActive: 0,
        probeWorklist: 5,
        probed: 5,
        live: 1,
        liveEmpty: 1,
        absent: 1,
        indeterminate: 1,
        transientFailed: 1,
        upserted: 2, // live + live-empty both write
        reprobed: 0, // the 2 upserted rows are excluded; no other active rows exist
        deactivated: 0,
        jobsClosedOnDeactivation: 0,
        wouldCloseOnDeactivation: 0,
      });

      // Only the live/live-empty slugs became rows; absent/indeterminate/transient never write.
      const live = await companyBySlug("livco");
      const empty = await companyBySlug("emptyco");
      expect(live).toBeDefined();
      expect(empty).toBeDefined();
      expect(await companyBySlug("goneco")).toBeUndefined();
      expect(await companyBySlug("indetco")).toBeUndefined();
      expect(await companyBySlug("flakyco")).toBeUndefined();
      // markProbeResult(true) ran: active, streak reset, staleness clock stamped (was NULL on a new row).
      expect(live!.active).toBe(true);
      expect(live!.consecutiveProbeFailures).toBe(0);
      expect(live!.lastLiveAt).toBeInstanceOf(Date);
      expect(live!.lastProbedAt).toBeInstanceOf(Date);

      // The run row: opened + terminalized ok, with the counts bag persisted verbatim.
      const runs = await allSourceRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.pipeline).toBe("discovery");
      expect(runs[0]!.source).toBeNull(); // opts.source omitted → all-sources run
      expect(runs[0]!.status).toBe("ok");
      expect(runs[0]!.finishedAt).toBeInstanceOf(Date);
      expect(runs[0]!.counts).toEqual(counts);

      // No reprobe fired (both live rows excluded): seed + 5 probes only.
      expect(fx.calls.filter((u) => u.includes("/v1/boards/")).length).toBe(5);
    });

    it("caps the worklist to opts.limit as a seed-ordered prefix — the tail is never probed", async () => {
      const fx = installFetch([seedRoute(["a1", "a2", "a3"]), liveRoute("a1")]);

      const counts = await runDiscovery(db, { lanes: ["outscal"], limit: 1, probe: PROBE_OPTS });

      expect(counts).toMatchObject({ candidates: 3, probeWorklist: 1, probed: 1, live: 1, upserted: 1 });
      // Only the first candidate became a row.
      expect(await companyBySlug("a1")).toBeDefined();
      expect(await companyBySlug("a2")).toBeUndefined();
      expect(await companyBySlug("a3")).toBeUndefined();
      // The slice really bounds the network: a2/a3 are never fetched (a dropped slice would probe all 3).
      expect(fx.calls.some((u) => probeMatch("a2")(u))).toBe(false);
      expect(fx.calls.some((u) => probeMatch("a3")(u))).toBe(false);
    });
  });

  describe("partition — NEW/INACTIVE to the probe path, KNOWN-ACTIVE to reprobe", () => {
    it("dryRun: excludes already-active candidates from the worklist, still probes + tallies, but writes NOTHING", async () => {
      // acme is KNOWN-ACTIVE (partitioned out); zombie is KNOWN-INACTIVE (re-probed); other is an
      // active bystander the seed never re-emits.
      await seedCompany({ slug: "acme", active: true });
      await seedCompany({
        slug: "zombie",
        active: false,
        consecutiveProbeFailures: 2,
        lastLiveAt: SENTINEL_2020,
        lastProbedAt: SENTINEL_2020,
      });
      await seedCompany({ slug: "other", active: true });

      const fx = installFetch([
        seedRoute(["acme", "zombie", "fresh"]),
        liveRoute("zombie"),
        liveRoute("fresh"),
      ]);

      const counts = await runDiscovery(db, { lanes: ["outscal"], dryRun: true, probe: PROBE_OPTS });

      expect(counts).toMatchObject({
        candidates: 3,
        alreadyActive: 1, // acme
        probeWorklist: 2, // zombie + fresh
        probed: 2,
        live: 2,
        upserted: 2, // counted even under dryRun (the write itself is gated, the tally is not)
        reprobed: 0,
        deactivated: 0,
      });

      // dryRun writes NOTHING: no new row, zombie stays inactive at its seeded sentinels, no run row.
      expect(await companyBySlug("fresh")).toBeUndefined();
      const zombie = await companyBySlug("zombie");
      expect(zombie!.active).toBe(false);
      expect(zombie!.consecutiveProbeFailures).toBe(2);
      expect(zombie!.lastLiveAt).toEqual(SENTINEL_2020);
      expect(await allSourceRuns()).toHaveLength(0); // dryRun → runId null → startRun never called
      // acme (already-active) and other (bystander) are never probed; only the worklist is.
      expect(fx.calls.some((u) => probeMatch("acme")(u))).toBe(false);
      expect(fx.calls.some((u) => probeMatch("other")(u))).toBe(false);
    });

    it("re-probes a KNOWN-INACTIVE candidate live → reactivates it, excludes it from reprobe, and leaves an un-re-emitted dead row untouched", async () => {
      await seedCompany({
        slug: "zombie",
        active: false,
        consecutiveProbeFailures: 3,
        lastLiveAt: SENTINEL_2020,
        lastProbedAt: SENTINEL_2020,
        updatedAt: SENTINEL_2020,
      });
      // A dead row the seed does NOT re-emit — must stay inactive (the partition keys on the seed set,
      // and reprobe skips inactive rows).
      await seedCompany({
        slug: "stilldead",
        active: false,
        consecutiveProbeFailures: 3,
        lastLiveAt: SENTINEL_2020,
      });

      const fx = installFetch([seedRoute(["zombie"]), liveRoute("zombie")]);

      const counts = await runDiscovery(db, { lanes: ["outscal"], probe: PROBE_OPTS });

      expect(counts).toMatchObject({ alreadyActive: 0, probeWorklist: 1, upserted: 1, reprobed: 0 });
      // zombie reactivated by the worklist live probe.
      const zombie = await companyBySlug("zombie");
      expect(zombie!.active).toBe(true);
      expect(zombie!.consecutiveProbeFailures).toBe(0);
      expect(zombie!.lastLiveAt!.getTime()).toBeGreaterThan(SENTINEL_2020.getTime());
      // stilldead is byte-for-byte untouched.
      const dead = await companyBySlug("stilldead");
      expect(dead!.active).toBe(false);
      expect(dead!.consecutiveProbeFailures).toBe(3);
      expect(dead!.lastLiveAt).toEqual(SENTINEL_2020);
      // EXCLUDE-just-upserted: zombie is probed exactly ONCE (worklist). Dropping the exclude filter would
      // re-probe the now-active zombie in the reprobe pass → a second probe + reprobed:1.
      expect(fx.calls.filter((u) => probeMatch("zombie")(u)).length).toBe(1);
    });

    it("a worklist candidate that probes ABSENT writes nothing — a re-emitted inactive row stays untouched", async () => {
      // zombie is KNOWN-INACTIVE and re-emitted, so it enters the worklist; its probe is absent (404).
      // probeAndUpsert writes ONLY on live/live-empty, so the worklist absent path is a pure no-op — UNLIKE
      // the reprobe pass, which calls markProbeResult(false) on absent (discover.ts:198 "an inactive one
      // stays inactive"). It is inactive, so the reprobe pass (active rows only) never touches it either.
      await seedCompany({
        slug: "zombie",
        active: false,
        consecutiveProbeFailures: 2,
        lastLiveAt: SENTINEL_2020,
        lastProbedAt: SENTINEL_2020,
        updatedAt: SENTINEL_2020,
      });
      installFetch([seedRoute(["zombie"]), absentRoute("zombie")]);

      const counts = await runDiscovery(db, { lanes: ["outscal"], probe: PROBE_OPTS });

      expect(counts).toMatchObject({ probeWorklist: 1, probed: 1, absent: 1, upserted: 0, reprobed: 0 });
      // No write of ANY kind: streak, both clocks, and active all frozen at their seeded sentinels.
      const zombie = await companyBySlug("zombie");
      expect(zombie!.active).toBe(false);
      expect(zombie!.consecutiveProbeFailures).toBe(2);
      expect(zombie!.lastLiveAt).toEqual(SENTINEL_2020);
      expect(zombie!.lastProbedAt).toEqual(SENTINEL_2020);
    });
  });

  describe("reprobe pass — refresh / mark-failed / inconclusive", () => {
    it("re-probes existing ACTIVE rows and routes each outcome to the right writer", async () => {
      // No lanes → empty worklist → the reprobe pass runs purely on these pre-seeded active rows.
      await seedCompany({
        slug: "refreshme",
        active: true,
        consecutiveProbeFailures: 1,
        lastLiveAt: SENTINEL_2020,
        lastProbedAt: new Date("2020-01-01T00:00:00Z"),
      });
      const failLive = daysAgo(5);
      await seedCompany({
        slug: "failme",
        active: true,
        consecutiveProbeFailures: 1,
        lastLiveAt: failLive, // recent → not swept by the later staleness pass
        lastProbedAt: new Date("2020-02-01T00:00:00Z"),
      });
      await seedCompany({
        slug: "inconclusiveme",
        active: true,
        consecutiveProbeFailures: 1,
        lastLiveAt: daysAgo(5),
        lastProbedAt: new Date("2020-03-01T00:00:00Z"),
      });

      installFetch([
        liveRoute("refreshme"),
        absentRoute("failme"),
        indeterminateRoute("inconclusiveme"),
      ]);

      const counts = await runDiscovery(db, { lanes: ["__none__"], probe: PROBE_OPTS });

      expect(counts).toMatchObject({
        probed: 0, // worklist empty
        reprobed: 3,
        refreshedLive: 1,
        markedFailed: 1,
        reprobeInconclusive: 1,
        deactivated: 0,
      });

      // refreshme: markProbeResult(true) — streak reset, staleness clock refreshed.
      const refresh = await companyBySlug("refreshme");
      expect(refresh!.consecutiveProbeFailures).toBe(0);
      expect(refresh!.lastLiveAt!.getTime()).toBeGreaterThan(SENTINEL_2020.getTime());
      // failme: markProbeResult(false) — streak++ but last_live_at (the staleness clock) untouched.
      const fail = await companyBySlug("failme");
      expect(fail!.consecutiveProbeFailures).toBe(2);
      expect(fail!.active).toBe(true);
      expect(fail!.lastLiveAt).toEqual(failLive);
      // inconclusiveme: markProbed — cursor advanced, streak UNCHANGED (proves it wasn't markProbeResult).
      const inc = await companyBySlug("inconclusiveme");
      expect(inc!.consecutiveProbeFailures).toBe(1);
      expect(inc!.lastProbedAt!.getTime()).toBeGreaterThan(new Date("2020-03-01T00:00:00Z").getTime());
    });

    it("honors reprobeLimit over the oldest-probed-first queue — the newest active row is a bystander", async () => {
      await seedCompany({ slug: "old1", active: true, lastLiveAt: daysAgo(1), lastProbedAt: new Date("2020-01-01T00:00:00Z") });
      await seedCompany({ slug: "old2", active: true, lastLiveAt: daysAgo(1), lastProbedAt: new Date("2020-02-01T00:00:00Z") });
      const newestProbed = new Date("2020-03-01T00:00:00Z");
      await seedCompany({ slug: "newest", active: true, lastLiveAt: daysAgo(1), lastProbedAt: newestProbed });

      installFetch([liveRoute("old1"), liveRoute("old2"), liveRoute("newest")]);

      const counts = await runDiscovery(db, { lanes: ["__none__"], reprobeLimit: 2, probe: PROBE_OPTS });

      expect(counts).toMatchObject({ reprobed: 2, refreshedLive: 2 });
      // The two OLDEST were reprobed (last_probed_at advanced); a reversed order would spare old1 instead.
      expect((await companyBySlug("old1"))!.lastProbedAt!.getTime()).toBeGreaterThan(
        new Date("2020-01-01T00:00:00Z").getTime(),
      );
      expect((await companyBySlug("old2"))!.lastProbedAt!.getTime()).toBeGreaterThan(
        new Date("2020-02-01T00:00:00Z").getTime(),
      );
      // The newest row was never reached by the limit — its cursor is frozen (a dropped limit reprobes it).
      expect((await companyBySlug("newest"))!.lastProbedAt).toEqual(newestProbed);
    });
  });

  describe("staleness sweep + board-death close", () => {
    async function seedSweepFixture() {
      // dying: qualifies for deactivation after its reprobe confirms absent; carries 2 active jobs.
      const dyingId = await seedCompany({
        slug: "dying",
        active: true,
        consecutiveProbeFailures: 1,
        lastLiveAt: daysAgo(40),
        lastProbedAt: new Date("2019-01-01T00:00:00Z"),
      });
      await seedJob(dyingId, "dying-1");
      await seedJob(dyingId, "dying-2");
      // healthy: reprobes live → stays active + not swept; its job is the board-close bystander.
      const healthyId = await seedCompany({
        slug: "healthy",
        active: true,
        consecutiveProbeFailures: 0,
        lastLiveAt: daysAgo(1),
        lastProbedAt: new Date("2019-01-01T00:00:00Z"),
      });
      await seedJob(healthyId, "healthy-1");
      return { dyingId, healthyId };
    }
    const sweepRoutes: Route[] = [absentRoute("dying"), liveRoute("healthy")];

    it("SHADOW (default): deactivates the stale board and TALLIES would-close jobs without closing them", async () => {
      const { dyingId, healthyId } = await seedSweepFixture();
      installFetch(sweepRoutes);

      const counts = await runDiscovery(db, { lanes: ["__none__"], probe: PROBE_OPTS });

      expect(counts).toMatchObject({
        markedFailed: 1,
        deactivated: 1,
        wouldCloseOnDeactivation: 2, // dying's 2 active jobs
        jobsClosedOnDeactivation: 0,
      });
      expect((await companyBySlug("dying"))!.active).toBe(false);
      // Shadow writes no 'closed' — every job stays active (dying's AND the healthy bystander's).
      expect((await jobsFor(dyingId)).every((j) => j.lifecycleState === "active")).toBe(true);
      expect((await jobsFor(healthyId))[0]!.lifecycleState).toBe("active");
    });

    it("ENFORCE: closes the deactivated board's active jobs (stamping closed_at) and spares the healthy board's job", async () => {
      const { dyingId, healthyId } = await seedSweepFixture();
      installFetch(sweepRoutes);

      const counts = await runDiscovery(db, {
        lanes: ["__none__"],
        enforceLifecycle: true,
        probe: PROBE_OPTS,
      });

      expect(counts).toMatchObject({
        deactivated: 1,
        jobsClosedOnDeactivation: 2,
        wouldCloseOnDeactivation: 0,
      });
      const dyingJobs = await jobsFor(dyingId);
      expect(dyingJobs.every((j) => j.lifecycleState === "closed")).toBe(true);
      expect(dyingJobs.every((j) => j.closedAt instanceof Date)).toBe(true);
      // The healthy (non-deactivated) board's job is NOT in the close set — company-scoped close.
      expect((await jobsFor(healthyId))[0]!.lifecycleState).toBe("active");
    });

    it("coerces a non-positive olderThanDays to the 30-day default — a within-window failing board is NOT swept", async () => {
      await seedCompany({
        slug: "recentfail",
        active: true,
        consecutiveProbeFailures: 1,
        lastLiveAt: daysAgo(10), // 10d < 30d default window
        lastProbedAt: new Date("2019-01-01T00:00:00Z"),
      });
      installFetch([absentRoute("recentfail")]);

      // olderThanDays:0 must coerce to 30. A plain `?? DEFAULT` would keep 0 → `< now() - 0` sweeps every
      // failing row, deactivating recentfail wrongly.
      const counts = await runDiscovery(db, { lanes: ["__none__"], olderThanDays: 0, probe: PROBE_OPTS });

      expect(counts).toMatchObject({ markedFailed: 1, deactivated: 0 });
      expect((await companyBySlug("recentfail"))!.active).toBe(true);
    });
  });

  describe("opts.source scoping", () => {
    it("scopes the whole run to one source — a stale failing board on ANOTHER source is a byte-for-byte bystander", async () => {
      // runDiscovery threads opts.source into the reprobe queue (listCompaniesForReprobe) AND the sweep
      // (deactivateStale). A lever board that is identically stale+failing must be excluded from both:
      // never reprobed (its probe URL never fetched) and never deactivated. Dropping `{ source: opts.source }`
      // from either orchestration call would touch it.
      await seedCompany({
        slug: "gh-dying",
        source: "greenhouse",
        active: true,
        consecutiveProbeFailures: 1,
        lastLiveAt: daysAgo(40),
        lastProbedAt: new Date("2019-01-01T00:00:00Z"),
      });
      const leverProbed = new Date("2019-06-01T00:00:00Z");
      await seedCompany({
        slug: "lever-dying",
        source: "lever",
        active: true,
        consecutiveProbeFailures: 1,
        lastLiveAt: daysAgo(40),
        lastProbedAt: leverProbed,
      });
      const fx = installFetch([absentRoute("gh-dying")]);

      const counts = await runDiscovery(db, {
        source: "greenhouse",
        lanes: ["__none__"],
        probe: PROBE_OPTS,
      });

      // Only the greenhouse row was reprobed (absent) then deactivated.
      expect(counts).toMatchObject({ reprobed: 1, markedFailed: 1, deactivated: 1 });
      expect((await companyBySlug("gh-dying"))!.active).toBe(false);
      // The lever row is untouched: never reprobed (api.lever.co never fetched), still active, cursor frozen.
      expect(fx.calls.some((u) => u.includes("api.lever.co"))).toBe(false);
      const lever = await companyBySlug("lever-dying");
      expect(lever!.active).toBe(true);
      expect(lever!.consecutiveProbeFailures).toBe(1);
      expect(lever!.lastProbedAt).toEqual(leverProbed);
    });
  });

  describe("run row — error terminalization", () => {
    it("a failLoud seed-lane fetch failure terminalizes the run 'error' with a secret-free sample and re-throws", async () => {
      // The outscal lane is failLoud: a broken seed fetch re-throws into runDiscovery's catch. A 500-char
      // statusText pushes the thrown message past the 500-char slice, so the truncation is load-bearing.
      installFetch([
        {
          match: (url) => url.includes("companies_v2.json"),
          respond: () => new Response("boom", { status: 500, statusText: "E".repeat(500) }),
        },
      ]);

      await expect(runDiscovery(db, { lanes: ["outscal"], probe: PROBE_OPTS })).rejects.toThrow(
        /Seed fetch failed/,
      );

      const runs = await allSourceRuns();
      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      expect(run.status).toBe("error"); // opened running → terminalized error in the catch
      expect(run.finishedAt).toBeInstanceOf(Date);
      expect(run.errorSample).toContain("Seed fetch failed: 500");
      // Exactly 500: the message is 523 chars pre-slice, so dropping `.slice(0, 500)` in discover.ts makes
      // this !== 500 — the truncation (secret-free shape sample) is now genuinely protected.
      expect(run.errorSample!.length).toBe(500);
    });
  });
});
