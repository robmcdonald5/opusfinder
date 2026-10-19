import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@opusfinder/db";
import { runPrune } from "@opusfinder/db/repos";
import { SCRAPERS_WORKER } from "@opusfinder/db/roles";
import { companies, jobs, sourceRuns } from "@opusfinder/db/schema";
import { runDiscovery } from "@opusfinder/discovery";
import { companySlug, jobId } from "@opusfinder/shared";
import { runIngestion } from "@opusfinder/sources";

import { createTestDb } from "@test/db/pglite";
import { setUpRole } from "@test/db/role";
import { truncate } from "@test/db/truncate";
import { oneHot } from "@test/db/vectors";
import { jsonResponse, routedFetch, textResponse, type Route } from "@test/http/fetch-router";

// The scrapers Worker (apps/scrapers) connects as the scrapers_worker role. An ingest tick, a discovery run and
// the weekly prune, with the Worker's options and data that makes them insert, update, close and delete in both
// modes, must succeed AS that role: a missing grant fails a query, which surfaces as a non-ok run or a non-zero failure tally. The
// role's exact grants are audited in packages/db/src/roles.integration.test.ts. This suite lives here because
// discovery is the lowest package that imports both pipelines (apps/scrapers' tests compile under Workers
// types, without PGlite).

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

// apps/scrapers/src/index.ts's options (its constants live in Worker-typed code), plus no retries so a test
// never waits on a backoff.
const INGEST_OPTS = {
  activeOnly: true,
  afterId: 0,
  limit: 250,
  maxRunMs: 600_000,
  adapter: { maxItems: 1500, maxRetryWaitMs: 5_000, boardTimeLimitMs: 120_000, maxRetries: 0 },
} as const;
const DISCOVERY_OPTS = {
  limit: 400,
  reprobeLimit: 500,
  workerOnly: true,
  maxRunMs: 600_000,
  probe: {
    maxRetryWaitMs: 5_000,
    maxRetries: 0,
    hostMinIntervalMs: 0,
    hostConcurrency: 20,
    globalConcurrency: 20,
  },
} as const;

// Greenhouse board / probe routing: boards-api.greenhouse.io/v1/boards/{slug}/jobs.
const ghBoard = (slug: string, respond: () => Response): Route => ({
  match: (url) => url.includes(`/v1/boards/${slug}/jobs`),
  respond,
});
const ghJobs = (ids: number[]) =>
  jsonResponse({
    jobs: ids.map((id) => ({ id, title: `Job ${id}`, absolute_url: `https://x/${id}` })),
  });
const boardUrl = (slug: string) => `https://boards.greenhouse.io/${slug}`;

describe("the scrapers Worker's pipelines as scrapers_worker (integration: real PGlite semantics)", () => {
  let db: Db;
  let pg: PGlite;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, client: pg, close } = await createTestDb());
    await setUpRole(pg, SCRAPERS_WORKER);
  });
  beforeEach(async () => {
    await truncate(db, companies, jobs, sourceRuns);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await pg.exec("RESET ROLE");
  });
  afterAll(async () => {
    await close?.();
  });

  async function seedCompany(
    values: Omit<typeof companies.$inferInsert, "source">,
  ): Promise<number> {
    const [row] = await db
      .insert(companies)
      .values({ ...values, source: "greenhouse" })
      .returning({ id: companies.id });
    return row!.id;
  }
  async function seedJob(
    companyId: number,
    externalId: string,
    values: Partial<typeof jobs.$inferInsert> = {},
  ): Promise<void> {
    await db.insert(jobs).values({
      externalId: jobId(externalId),
      companyId,
      source: "greenhouse",
      title: "seeded job",
      remote: false,
      applyUrl: "https://x/apply",
      ...values,
    });
  }
  async function job(externalId: string) {
    const [row] = await db
      .select()
      .from(jobs)
      .where(eq(jobs.externalId, jobId(externalId)));
    return row;
  }
  async function company(slug: string) {
    const [row] = await db
      .select()
      .from(companies)
      .where(eq(companies.slug, companySlug(slug)));
    return row;
  }
  async function runRows() {
    return db.select().from(sourceRuns);
  }

  it.each([false, true])(
    "an ingest tick inserts, updates, revives, sweeps and stale-closes (enforce=%s)",
    async (enforce) => {
      const acme = await seedCompany({ slug: companySlug("acme") });
      await seedJob(acme, "1", { title: "old title", embedding: oneHot(0) }); // listed, changed
      await seedJob(acme, "2", { lifecycleState: "closed", closedAt: daysAgo(1) }); // listed again: revives
      await seedJob(acme, "8", { lastSeenAt: daysAgo(30) }); // absent and past the TTL
      await seedJob(acme, "9", { consecutiveAbsences: 2 }); // absent at the close threshold
      vi.stubGlobal("fetch", routedFetch([ghBoard("acme", () => ghJobs([1, 2, 3]))]));

      await pg.exec(`SET ROLE ${SCRAPERS_WORKER.name}`);
      const counts = await runIngestion(db, {
        ...INGEST_OPTS,
        enforceLifecycle: enforce,
        staleSweep: { ttlDays: 21, enforce },
      });
      await pg.exec("RESET ROLE");

      expect(counts).toMatchObject({
        ok: 1,
        failed: 0,
        sweepFailed: 0,
        markFailed: 0,
        staleSweepFailed: 0,
        jobs: 3,
        changed: 3,
        ...(enforce ? { closed: 1, staleClosed: 1 } : { wouldClose: 1, staleWouldClose: 1 }),
      });
      expect(await runRows()).toMatchObject([
        { pipeline: "ingestion", status: "ok", errorSample: null },
      ]);
      expect(await job("3")).toBeDefined();
      expect((await job("1"))!.embedding).toBeNull();
      expect((await job("2"))!.lifecycleState).toBe("active");
      expect((await company("acme"))!.lastIngestedAt).toBeInstanceOf(Date);
    },
  );

  it.each([false, true])(
    "a discovery run reprobes, upserts, reactivates, deactivates and closes a dead board's jobs (enforce=%s)",
    async (enforce) => {
      await seedCompany({ slug: companySlug("liveco") });
      const goneco = await seedCompany({
        slug: companySlug("goneco"),
        consecutiveProbeFailures: 1,
        lastLiveAt: daysAgo(60),
        createdAt: daysAgo(60),
      });
      await seedJob(goneco, "1");
      await seedCompany({ slug: companySlug("flakyco") });
      await seedCompany({ slug: companySlug("backco"), active: false });
      const live = () => ghJobs([1]);
      vi.stubGlobal(
        "fetch",
        routedFetch([
          {
            match: (url) => url.includes("companies_v2.json"),
            respond: () => jsonResponse([{ ats_links: [boardUrl("newco"), boardUrl("backco")] }]),
          },
          {
            match: (url) => url.includes("hn.algolia.com/api/v1/search_by_date"),
            respond: () =>
              jsonResponse({ hits: [{ objectID: "1", title: "Ask HN: Who is hiring?" }] }),
          },
          {
            match: (url) => url.includes("hn.algolia.com/api/v1/items/1"),
            respond: () => jsonResponse({ children: [{ text: `Apply: ${boardUrl("newco")}` }] }),
          },
          ghBoard("liveco", live),
          ghBoard("newco", live),
          ghBoard("backco", live),
          ghBoard("goneco", () => textResponse("Not Found", 404)),
          ghBoard("flakyco", () => textResponse("busy", 500)),
        ]),
      );

      await pg.exec(`SET ROLE ${SCRAPERS_WORKER.name}`);
      const counts = await runDiscovery(db, { ...DISCOVERY_OPTS, enforceLifecycle: enforce });
      await pg.exec("RESET ROLE");

      expect(counts).toMatchObject({
        reprobed: 3,
        refreshedLive: 1,
        markedFailed: 1,
        reprobeInconclusive: 1,
        upserted: 2,
        deactivated: 1,
        ...(enforce ? { jobsClosedOnDeactivation: 1 } : { wouldCloseOnDeactivation: 1 }),
      });
      expect(counts).not.toHaveProperty("lane_hn_error");
      expect(await runRows()).toMatchObject([
        { pipeline: "discovery", status: "ok", errorSample: null },
      ]);
      expect((await company("newco"))!.active).toBe(true);
      expect((await company("backco"))!.active).toBe(true);
      expect((await company("goneco"))!.active).toBe(false);
    },
  );

  it.each([false, true])(
    "the weekly prune deletes only old closed jobs, through its function (apply=%s)",
    async (apply) => {
      const acme = await seedCompany({ slug: companySlug("acme") });
      await seedJob(acme, "old", { lifecycleState: "closed", closedAt: daysAgo(40) });
      await seedJob(acme, "recent", { lifecycleState: "closed", closedAt: daysAgo(5) });
      await seedJob(acme, "live");

      await pg.exec(`SET ROLE ${SCRAPERS_WORKER.name}`);
      const counts = await runPrune(db, { apply, maxRows: 20_000 });
      await pg.exec("RESET ROLE");

      expect(counts).toEqual({ prunable: 1, deleted: apply ? 1 : 0 });
      expect(await runRows()).toMatchObject([
        { pipeline: "prune", status: "ok", errorSample: null },
      ]);
      expect(await job("old")).toEqual(apply ? undefined : expect.anything());
      expect(await job("recent")).toBeDefined();
      expect(await job("live")).toBeDefined();
    },
  );

  it("is denied the user-side tables and DELETE", async () => {
    await pg.exec(`SET ROLE ${SCRAPERS_WORKER.name}`);
    for (const table of [
      '"user"',
      "session",
      "user_profiles",
      "user_preferences",
      "digest_items",
    ]) {
      await expect(pg.query(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toThrow(/permission denied/);
    }
    await expect(pg.query("DELETE FROM jobs")).rejects.toThrow(/permission denied/);
  });
});
