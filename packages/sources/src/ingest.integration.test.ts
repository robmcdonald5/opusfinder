import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@opusfinder/db";
import { companies, jobs, sourceRuns } from "@opusfinder/db/schema";
import { companySlug, jobId, type SourceName } from "@opusfinder/shared";
import { runIngestion, type IngestEmbedFn, type IngestionOptions } from "@opusfinder/sources";

import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";
import { oneHot } from "@test/db/vectors";
import { jsonResponse, routedFetch, textResponse, type Route } from "@test/http/fetch-router";

// What this file proves: the runIngestion ORCHESTRATION over real PGlite — iterate the companies chunk,
// drive each board through its adapter (greenhouse, a real driver) with the global `fetch` stubbed, upsert,
// stamp presence/health, sweep, embed, and close on the staleness timer, all under one source_runs row.
// Focus is the wiring NO other suite owns: per-board error ISOLATION (one bad board never fails the run),
// the activeOnly/afterId/limit SQL chunk, the maxRunMs budget break (finishRun still reached), the capped-
// board sweep SKIP with presence still stamped, the total>0 gate, closed-job revival, the injected embedder
// (+ its failure isolation), and the post-loop staleness sweep (shadow/enforce, INDEPENDENT of the per-board
// enforce switch). NOT this file's job: upsertJobs batch/dedupe/setWhere semantics (jobs.integration.test.ts),
// the run-row once-only terminalize (runs.integration.test.ts), the sweepLifecycle/sweepStaleJobs internal
// SQL (lifecycle.test.ts + the db repos), and the adapter mappers (per-adapter unit suites).

// Adapter tuning that removes real waits: no retries (a 5xx fails the board on the first attempt, no
// `backoff` setTimeout) — paired with paceMs:0 (no inter-board sleep).
// IngestBoardResult isn't re-exported from the sources barrel; derive it from the onBoard param so the
// test needs no production surface change.
type IngestBoardResult = Parameters<NonNullable<IngestionOptions["onBoard"]>>[0];

const NO_RETRY = { maxRetries: 0 } as const;
const DAY_MS = 86_400_000;
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS);
}

// ── greenhouse board routing (boards-api.greenhouse.io/v1/boards/{slug}/jobs, `{ jobs: [...] }`) ──
const boardMatch = (slug: string) => (url: string) => url.includes(`/v1/boards/${slug}/jobs`);
function ghJob(id: number): { id: number; title: string; absolute_url: string } {
  return { id, title: `Job ${id}`, absolute_url: `https://x/${id}` };
}
const boardRoute = (slug: string, jobList: unknown[]): Route => ({
  match: boardMatch(slug),
  respond: () => jsonResponse({ jobs: jobList }),
});
const failRoute = (slug: string, status = 500): Route => ({
  match: boardMatch(slug),
  respond: () => textResponse("err", status),
});

interface CompanySeed {
  slug: string;
  source?: SourceName;
  active?: boolean;
  lastIngestedAt?: Date | null;
}
interface JobSeed {
  externalId: string;
  title?: string;
  lifecycleState?: "active" | "closed";
  closedAt?: Date | null;
  consecutiveAbsences?: number;
  lastSeenAt?: Date;
}

describe("runIngestion — orchestration over real PGlite (fetch stubbed)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    await truncate(db, companies, jobs, sourceRuns);
  });
  afterEach(() => {
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
        lastIngestedAt: seed.lastIngestedAt,
      })
      .returning({ id: companies.id });
    return rows[0]!.id;
  }

  async function seedJob(companyId: number, seed: JobSeed): Promise<void> {
    await db.insert(jobs).values({
      externalId: jobId(seed.externalId),
      companyId,
      source: "greenhouse",
      title: seed.title ?? "seeded job",
      remote: false,
      applyUrl: "https://x/apply",
      lifecycleState: seed.lifecycleState,
      closedAt: seed.closedAt,
      consecutiveAbsences: seed.consecutiveAbsences,
      lastSeenAt: seed.lastSeenAt,
    });
  }

  async function jobsFor(companyId: number) {
    return db.select().from(jobs).where(eq(jobs.companyId, companyId)).orderBy(jobs.externalId);
  }
  async function jobByExt(externalId: string) {
    const rows = await db.select().from(jobs).where(eq(jobs.externalId, jobId(externalId)));
    return rows[0];
  }
  async function companyById(id: number) {
    const rows = await db.select().from(companies).where(eq(companies.id, id));
    return rows[0]!;
  }
  async function allSourceRuns() {
    return db.select().from(sourceRuns);
  }

  describe("happy path + run row", () => {
    it("fetches a board, upserts its jobs, stamps presence + board-health, and terminalizes the run 'ok'", async () => {
      const acme = await seedCompany({ slug: "acme", active: true });
      installFetch([boardRoute("acme", [ghJob(1), ghJob(2)])]);

      const counts = await runIngestion(db, { paceMs: 0, adapter: NO_RETRY });

      expect(counts).toMatchObject({
        companies: 1,
        processed: 1,
        ok: 1,
        failed: 0,
        jobs: 2,
        changed: 2,
        embedded: 0, // no embedder injected
        markFailed: 0,
        cappedBoards: 0,
        lastId: acme,
      });
      // Both postings persisted.
      expect(await jobsFor(acme)).toHaveLength(2);
      // markCompanyIngested certified board health (total>0) — the staleness timer's precondition.
      expect((await companyById(acme)).lastIngestedAt).toBeInstanceOf(Date);
      // The run row, opened + terminalized ok with the counts bag verbatim.
      const runs = await allSourceRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.pipeline).toBe("ingestion");
      expect(runs[0]!.status).toBe("ok");
      expect(runs[0]!.counts).toEqual(counts);
    });
  });

  describe("per-board error isolation", () => {
    it("isolates failing boards: keeps the run 'ok', increments failed per board, and captures ONLY the FIRST error", async () => {
      // Two failing boards with distinct ids + statuses: badalpha (lower id, 500) is processed first
      // (ORDER BY id), badbeta (503) second; goodco succeeds. errorSample must retain badalpha's error
      // (the `errorSample ??=` first-write-wins), never badbeta's — a `??=`→`=` last-wins regression flips it.
      await seedCompany({ slug: "badalpha", active: true });
      await seedCompany({ slug: "badbeta", active: true });
      const goodco = await seedCompany({ slug: "goodco", active: true });
      installFetch([
        failRoute("badalpha", 500),
        failRoute("badbeta", 503),
        boardRoute("goodco", [ghJob(1)]),
      ]);

      const boards: IngestBoardResult[] = [];
      const counts = await runIngestion(db, {
        paceMs: 0,
        adapter: NO_RETRY,
        onBoard: (r) => boards.push(r),
      });

      // A per-board throw NEVER fails the run — only failed++ + first-error capture.
      expect(counts).toMatchObject({ companies: 3, processed: 3, ok: 1, failed: 2, jobs: 1, changed: 1 });
      const runs = await allSourceRuns();
      expect(runs[0]!.status).toBe("ok"); // an isolated board error must not terminalize the run 'error'
      expect(runs[0]!.errorSample).toMatch(/badalpha/);
      expect(runs[0]!.errorSample).toMatch(/500/);
      expect(runs[0]!.errorSample).not.toMatch(/badbeta/); // first-error-only: the 503 board never overwrites
      expect(runs[0]!.errorSample).not.toMatch(/503/);
      // The good board's jobs still landed.
      expect(await jobsFor(goodco)).toHaveLength(1);
      // onBoard fired once per board, in order, with the ok flag + error message.
      expect(boards).toHaveLength(3);
      expect(boards[0]).toMatchObject({ slug: "badalpha", ok: false });
      expect(boards[0]!.error).toMatch(/500/);
      expect(boards[2]).toMatchObject({ slug: "goodco", ok: true, jobs: 1 });
    });
  });

  describe("the listCompanies SQL chunk (activeOnly / afterId / limit)", () => {
    it("defaults activeOnly:true — a deactivated board is never fetched", async () => {
      const active = await seedCompany({ slug: "activeco", active: true });
      const inactive = await seedCompany({ slug: "inactiveco", active: false });
      const fx = installFetch([boardRoute("activeco", [ghJob(1)]), boardRoute("inactiveco", [ghJob(1)])]);

      const counts = await runIngestion(db, { paceMs: 0, adapter: NO_RETRY });

      expect(counts).toMatchObject({ companies: 1, processed: 1 });
      expect(fx.calls.some((u) => boardMatch("inactiveco")(u))).toBe(false); // never fetched
      expect(await jobsFor(inactive)).toHaveLength(0);
      expect(await jobsFor(active)).toHaveLength(1);
    });

    it("activeOnly:false includes the deactivated board", async () => {
      await seedCompany({ slug: "activeco", active: true });
      const inactive = await seedCompany({ slug: "inactiveco", active: false });
      installFetch([boardRoute("activeco", [ghJob(1)]), boardRoute("inactiveco", [ghJob(1)])]);

      const counts = await runIngestion(db, { activeOnly: false, paceMs: 0, adapter: NO_RETRY });

      expect(counts).toMatchObject({ companies: 2, processed: 2 });
      expect(await jobsFor(inactive)).toHaveLength(1);
    });

    it("afterId + limit fetch exactly the id-keyset slice, and lastId records the cursor", async () => {
      const c1 = await seedCompany({ slug: "c1", active: true });
      const c2 = await seedCompany({ slug: "c2", active: true });
      const c3 = await seedCompany({ slug: "c3", active: true });
      const fx = installFetch([
        boardRoute("c1", [ghJob(1)]),
        boardRoute("c2", [ghJob(1)]),
        boardRoute("c3", [ghJob(1)]),
      ]);

      const counts = await runIngestion(db, {
        afterId: c1,
        limit: 1,
        paceMs: 0,
        adapter: NO_RETRY,
      });

      // WHERE id > c1 ORDER BY id LIMIT 1 → exactly [c2].
      expect(counts).toMatchObject({ companies: 1, processed: 1, lastId: c2 });
      expect(fx.calls.some((u) => boardMatch("c1")(u))).toBe(false);
      expect(fx.calls.some((u) => boardMatch("c3")(u))).toBe(false);
      expect(await jobsFor(c2)).toHaveLength(1);
      expect(await jobsFor(c3)).toHaveLength(0);
    });
  });

  describe("maxRunMs budget", () => {
    it("stops starting boards once the budget is spent but still reaches finishRun and advances the cursor to the last processed id", async () => {
      const c1 = await seedCompany({ slug: "c1", active: true });
      await seedCompany({ slug: "c2", active: true });
      await seedCompany({ slug: "c3", active: true });
      const fx = installFetch([
        boardRoute("c1", [ghJob(1)]),
        boardRoute("c2", [ghJob(1)]),
        boardRoute("c3", [ghJob(1)]),
      ]);

      // maxRunMs:0 makes the break DETERMINISTIC (no wall-clock coupling): at i=1 the budget check is
      // `Date.now() - startMs >= 0`, always true, so the loop BREAKS before board 1 regardless of how fast
      // board 0 ran, while `i > 0` still guarantees board 0 processes. (maxRunMs:1 would hinge on board 0
      // taking >=1ms — a timing-dependent CI flake on a fast/idle runner.) companies stays the full chunk
      // size; processed is the early-stop signal.
      const counts = await runIngestion(db, { maxRunMs: 0, paceMs: 0, adapter: NO_RETRY });

      expect(counts).toMatchObject({ companies: 3, processed: 1, ok: 1, lastId: c1 });
      // BREAK (not return): finishRun is still reached and the run terminalizes ok.
      const runs = await allSourceRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("ok");
      // Boards 2 and 3 were never started.
      expect(fx.calls.some((u) => boardMatch("c2")(u))).toBe(false);
      expect(fx.calls.some((u) => boardMatch("c3")(u))).toBe(false);
    });
  });

  describe("capped board (partial fetch)", () => {
    it("skips the feed-absence sweep on a capped board but STILL stamps presence — the un-fetched tail is spared", async () => {
      const capco = await seedCompany({ slug: "capco", active: true });
      // A pre-existing active job that is ABSENT from the capped fetch: if the sweep ran, it would be
      // marked absent (streak++); the capped skip is what leaves it untouched.
      await seedJob(capco, { externalId: "old-99", lifecycleState: "active", consecutiveAbsences: 0 });

      // Board returns 2 jobs; maxItems:1 trims to 1 → normalized.length(1) >= cap(1) ⇒ capped.
      installFetch([boardRoute("capco", [ghJob(1), ghJob(2)])]);
      const counts = await runIngestion(db, {
        paceMs: 0,
        adapter: { maxItems: 1, maxRetries: 0 },
      });

      expect(counts).toMatchObject({
        cappedBoards: 1,
        jobs: 1, // trimmed to maxItems before upsert
        swept: 0, // the per-board sweep did not run
        wouldClose: 0,
        closed: 0,
      });
      // The un-fetched tail job is untouched (a running sweep would have incremented its streak).
      const tail = await jobByExt("old-99");
      expect(tail!.lifecycleState).toBe("active");
      expect(tail!.consecutiveAbsences).toBe(0);
      // (That markJobsPresent still RUNS on a capped board is proven by the capped-revival test below —
      // a `toBeDefined()` on the fetched row here would only prove upsertJobs ran, not markJobsPresent.)
    });
  });

  describe("presence/health gate + revival", () => {
    it("an empty fetch (total 0) stamps NEITHER presence NOR board-health — last_ingested_at stays NULL", async () => {
      const emptyco = await seedCompany({ slug: "emptyco", active: true, lastIngestedAt: null });
      installFetch([boardRoute("emptyco", [])]);

      const counts = await runIngestion(db, { paceMs: 0, adapter: NO_RETRY });

      expect(counts).toMatchObject({ companies: 1, ok: 1, jobs: 0, changed: 0, revived: 0 });
      // The total>0 gate held: an empty/ambiguous fetch must NOT certify the board healthy (which would
      // then let the staleness timer close its still-live jobs).
      expect((await companyById(emptyco)).lastIngestedAt).toBeNull();
    });

    it("revives a reappearing closed job on a CAPPED board — markJobsPresent is the SOLE reviver (sweepLifecycle skipped)", async () => {
      const revco = await seedCompany({ slug: "revco", active: true });
      await seedJob(revco, {
        externalId: "1", // matches ghJob(1).id → reappears in the (capped) fetch
        lifecycleState: "closed",
        closedAt: new Date("2026-01-01T00:00:00Z"),
        consecutiveAbsences: 3,
      });
      // maxItems:1 caps the board → the feed-absence sweep is SKIPPED, so ANY revival can come only from
      // markJobsPresent. (A non-capped fixture cannot attribute it: sweepLifecycle's present-branch also
      // revives + counts `revived`, masking a broken markJobsPresent.) The trimmed present job IS the id.
      installFetch([boardRoute("revco", [ghJob(1), ghJob(2)])]);

      const counts = await runIngestion(db, { paceMs: 0, adapter: { maxItems: 1, maxRetries: 0 } });

      // upsertJobs never revives (see jobs.integration.test.ts) and sweepLifecycle didn't run → this
      // revived:1 is markJobsPresent's alone.
      expect(counts).toMatchObject({ cappedBoards: 1, revived: 1, swept: 0 });
      const job = await jobByExt("1");
      expect(job!.lifecycleState).toBe("active");
      expect(job!.closedAt).toBeNull();
      expect(job!.consecutiveAbsences).toBe(0);
    });
  });

  describe("injected embedder", () => {
    it("embeds the board's postings through the injected embedder and tallies embedded + tokens", async () => {
      const embco = await seedCompany({ slug: "embco", active: true });
      installFetch([boardRoute("embco", [ghJob(1), ghJob(2)])]);

      const seen: { count: number; inputType: string | null } = { count: 0, inputType: "unset" };
      const embed: IngestEmbedFn = (texts, params) => {
        seen.count += texts.length;
        seen.inputType = params.inputType;
        return Promise.resolve({
          embeddings: texts.map(() => oneHot(0)),
          usage: { totalTokens: texts.length * 10 },
        });
      };

      const counts = await runIngestion(db, { embed, paceMs: 0, adapter: NO_RETRY });

      expect(counts).toMatchObject({ embedded: 2, embedTokens: 20, embedFailed: 0 });
      expect(seen).toEqual({ count: 2, inputType: "document" }); // jobs embed as "document"
      // Vectors landed on both rows.
      const rows = await jobsFor(embco);
      expect(rows.every((r) => r.embedding !== null)).toBe(true);
    });

    it("isolates an embedder failure: jobs stay persisted, embedFailed++, the run stays 'ok', and the warning rides onBoard", async () => {
      await seedCompany({ slug: "embfail", active: true });
      installFetch([boardRoute("embfail", [ghJob(1)])]);
      const embed: IngestEmbedFn = () => Promise.reject(new Error("voyage down"));

      const boards: IngestBoardResult[] = [];
      const counts = await runIngestion(db, {
        embed,
        paceMs: 0,
        adapter: NO_RETRY,
        onBoard: (r) => boards.push(r),
      });

      expect(counts).toMatchObject({ embedded: 0, embedFailed: 1, jobs: 1, ok: 1, failed: 0 });
      expect((await allSourceRuns())[0]!.status).toBe("ok"); // an embed hiccup never fails the run
      const job = await jobByExt("1");
      expect(job).toBeDefined();
      expect(job!.embedding).toBeNull(); // persisted, just un-embedded → the next backfill fills it
      // The failure surfaces as a per-board WARNING (ok:true — the jobs DID persist), not a board error.
      expect(boards[0]).toMatchObject({ ok: true });
      expect(boards[0]!.error).toMatch(/voyage down/);
    });
  });

  describe("post-loop staleness sweep (opt-in, independent enforce switch)", () => {
    // timer-co is INACTIVE (excluded from the ingest loop) but healthy (last_ingested_at recent) with a
    // stale active job — the global sweepStaleJobs (no active filter) is the only path that touches it, so
    // it isolates the post-loop timer from the per-board sweep. gh-co is a normal active board.
    async function seedStaleFixture(): Promise<{ ghco: number; timerJobExt: string }> {
      const ghco = await seedCompany({ slug: "ghco", active: true });
      const timer = await seedCompany({
        slug: "timerco",
        active: false,
        lastIngestedAt: daysAgo(1), // healthy → passes the board-health guard
      });
      await seedJob(timer, {
        externalId: "t1",
        lifecycleState: "active",
        lastSeenAt: daysAgo(30), // past the 21-day TTL → stale
      });
      return { ghco, timerJobExt: "t1" };
    }
    const staleRoutes = (): Route[] => [boardRoute("ghco", [ghJob(1)])];

    it("SHADOW: tallies staleWouldClose without closing — and staleSweep.enforce is INDEPENDENT of enforceLifecycle", async () => {
      const { timerJobExt } = await seedStaleFixture();
      installFetch(staleRoutes());

      // enforceLifecycle:true (per-board close ON) but staleSweep.enforce:false — the timer must NOT close.
      const counts = await runIngestion(db, {
        paceMs: 0,
        adapter: NO_RETRY,
        enforceLifecycle: true,
        staleSweep: { enforce: false },
      });

      expect(counts).toMatchObject({ staleWouldClose: 1, staleClosed: 0, staleSweepFailed: 0 });
      // The per-board enforce switch did NOT leak into the timer: the stale job is still active.
      expect((await jobByExt(timerJobExt))!.lifecycleState).toBe("active");
    });

    it("ENFORCE: closes the stale job (stamping closed_at) after the loop", async () => {
      const { timerJobExt } = await seedStaleFixture();
      installFetch(staleRoutes());

      const counts = await runIngestion(db, {
        paceMs: 0,
        adapter: NO_RETRY,
        staleSweep: { enforce: true },
      });

      expect(counts).toMatchObject({ staleClosed: 1, staleWouldClose: 0 });
      const job = await jobByExt(timerJobExt);
      expect(job!.lifecycleState).toBe("closed");
      expect(job!.closedAt).toBeInstanceOf(Date);
    });

    it("omitting staleSweep skips the timer entirely — a stale job is left untouched", async () => {
      const { timerJobExt } = await seedStaleFixture();
      installFetch(staleRoutes());

      const counts = await runIngestion(db, { paceMs: 0, adapter: NO_RETRY });

      // The opt gate: with no staleSweep, sweepStaleJobs is never called (a dropped gate would close t1).
      expect(counts).toMatchObject({ staleWouldClose: 0, staleClosed: 0 });
      expect((await jobByExt(timerJobExt))!.lifecycleState).toBe("active");
    });
  });
});
