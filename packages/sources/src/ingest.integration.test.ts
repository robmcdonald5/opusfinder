import { DrizzleQueryError, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@opusfinder/db";
import { upsertCompany, upsertJobs } from "@opusfinder/db/repos";
import { companies, jobs, sourceRuns } from "@opusfinder/db/schema";
import { companySlug, jobId, type SourceName } from "@opusfinder/shared";
import {
  adapters,
  runIngestion,
  type IngestEmbedFn,
  type IngestionCounts,
  type IngestionOptions,
} from "@opusfinder/sources";

import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";
import { oneHot } from "@test/db/vectors";
import { jsonResponse, routedFetch, textResponse, type Route } from "@test/http/fetch-router";

// What this file proves: the runIngestion ORCHESTRATION over real PGlite — iterate the companies chunk,
// drive each board through its adapter (greenhouse, a real driver) with the global `fetch` stubbed, upsert,
// stamp presence/health, sweep, embed, and close on the staleness timer, all under one source_runs row.
// Focus is the wiring NO other suite owns: per-board error ISOLATION (one bad board never fails the run),
// the activeOnly/afterId/limit SQL chunk, the maxRunMs budget break (finishRun still reached), the capped-
// board sweep SKIP with presence still stamped, the non-empty-fetch gate, closed-job revival, the injected
// embedder (+ its failure isolation), the post-loop staleness sweep (shadow/enforce, INDEPENDENT of the per-board
// enforce switch), same-source-only pacing (per key, Workable's slower, the caller's floor), the per-key rate-limit cooldown, the company id taken from listCompanies (no upsertCompany), and a
// failed hydrate end to end (stored content kept, still present, hydrateSkipped counted accurately).
// NOT this file's job: upsertJobs batch/dedupe/setWhere semantics (jobs.integration.test.ts),
// the run-row once-only terminalize (runs.integration.test.ts), the sweepLifecycle/sweepStaleJobs internal
// SQL (lifecycle.test.ts + the db repos), and the adapter mappers (per-adapter unit suites).

// The inter-board pace `sleep` is STUBBED for the whole file: it records `sleep:<ms>` into `paced.events`
// (beside the `fetch:<slug>` a pacing test's routes record), advances the fake clock `paced.now` by `ms`
// (the pacing tests inject `clock: () => paced.now`), and resolves at once — no real timers, so the pacing
// tests assert the exact interleaving. `backoff` stays real (NO_RETRY below never reaches it).
const paced = vi.hoisted(() => ({ events: [] as string[], now: 0 }));
vi.mock("@opusfinder/shared/async", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opusfinder/shared/async")>();
  return {
    ...actual,
    sleep: (ms: number): Promise<void> => {
      paced.events.push(`sleep:${ms}`);
      paced.now += ms;
      return Promise.resolve();
    },
  };
});
// Pass-through spies on the two writers runIngestion could call per board: upsertCompany must never be
// (the id comes from listCompanies), and upsertJobs can be made to throw once (a failed write).
vi.mock("@opusfinder/db/repos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opusfinder/db/repos")>();
  return {
    ...actual,
    upsertCompany: vi.fn(actual.upsertCompany),
    upsertJobs: vi.fn(actual.upsertJobs),
  };
});

// Adapter tuning that removes real waits: no retries (a 5xx fails the board on the first attempt, no
// `backoff` setTimeout) — paired with paceMs:0 (the stubbed sleep is a no-op anyway).
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

// ── Workable board routing (apply.workable.com/api/v1/widget/accounts/{slug}?details=true, `{ jobs: [...] }`).
// Records `fetch:<slug>` into paced.events; a non-200 answers an HTML body (plus an optional Retry-After), as
// Workable's real 429 does. ──
function wkJob(code: string): { shortcode: string; title: string; url: string } {
  return { shortcode: code, title: `W ${code}`, url: `https://x/${code}` };
}
const workableBoard = (slug: string, status: number, jobList: unknown[] = [], retryAfter?: string): Route => ({
  match: (url) => url.includes(`/widget/accounts/${slug}?`),
  respond: () => {
    paced.events.push(`fetch:${slug}`);
    if (status === 200) return jsonResponse({ jobs: jobList });
    return new Response("<html>slow down</html>", {
      status,
      headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
    });
  },
});

// ── SmartRecruiters routing: the list `…/companies/{slug}/postings?…`, then one N+1 detail fetch per
// posting `…/companies/{slug}/postings/{id}` — the hydrate whose failure is a contentMissing posting. ──
const srDetail = (id: string) => ({
  jobAd: { sections: { jobDescription: { text: `<p>About ${id}</p>` } } },
  applyUrl: `https://x/${id}`,
});
/** An SR board listing `ids` (repeats allowed); `detail(id)` answers each posting's detail fetch. */
function srBoard(slug: string, ids: string[], detail: (id: string) => Response): Route[] {
  return [
    {
      match: (url) => url.includes(`/companies/${slug}/postings?`),
      respond: () =>
        jsonResponse({
          totalFound: ids.length,
          content: ids.map((id) => ({ id, name: `SR ${id}` })),
        }),
    },
    {
      match: (url) => url.includes(`/companies/${slug}/postings/`),
      respond: (url) => detail(url.slice(url.lastIndexOf("/") + 1)),
    },
  ];
}

interface CompanySeed {
  slug: string;
  source?: SourceName;
  active?: boolean;
  lastIngestedAt?: Date | null;
}
interface JobSeed {
  externalId: string;
  source?: SourceName;
  title?: string;
  descriptionText?: string;
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
    paced.events.length = 0;
    paced.now = 0;
    // mockReset (not mockClear) also drops an unconsumed mockRejectedValueOnce, restoring the pass-through.
    vi.mocked(upsertCompany).mockReset();
    vi.mocked(upsertJobs).mockReset();
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
      source: seed.source ?? "greenhouse",
      title: seed.title ?? "seeded job",
      descriptionText: seed.descriptionText,
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
      // markCompanyIngested certified board health (a non-empty fetch) — the staleness timer's precondition.
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

    it("the summary line says the budget stopped the run (processed/companies), and only when it did", async () => {
      await seedCompany({ slug: "c1", active: true });
      await seedCompany({ slug: "c2", active: true });
      await seedCompany({ slug: "c3", active: true });
      installFetch([boardRoute("c1", []), boardRoute("c2", []), boardRoute("c3", [])]);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await runIngestion(db, { maxRunMs: 0, paceMs: 0, adapter: NO_RETRY }); // stops after board 1
        await runIngestion(db, { paceMs: 0, adapter: NO_RETRY }); // processes all 3

        const summaries = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("Ingestion:"));
        expect(summaries).toHaveLength(2);
        const [stopped, full] = summaries;
        expect(stopped).toMatch(/^Ingestion: 3 board\(s\) — 1 ok; budget stop: processed 1\/3; /);
        expect(full).toMatch(/^Ingestion: 3 board\(s\) — 3 ok; /);
        expect(full).not.toContain("budget stop");
      } finally {
        log.mockRestore();
      }
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
      // The non-empty-fetch gate held: an empty/ambiguous fetch must NOT certify the board healthy (which would
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
      expect((await allSourceRuns())[0]!.errorSample).toBeNull(); // a warning, not a board error
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

  describe("a posting whose detail fetch failed (contentMissing) keeps its stored content", () => {
    it("keeps stored content, stamps the posting present, defers a new one, and counts all three", async () => {
      const sr = await seedCompany({ slug: "srco", source: "smartrecruiters", active: true });
      // sr-1: stored, its detail 500s. sr-4: stored, its detail is JSON null (an edge/maintenance body):
      // both content missing, still present.
      for (const id of ["sr-1", "sr-4"]) {
        await seedJob(sr, {
          externalId: id,
          source: "smartrecruiters",
          descriptionText: `Stored ${id}`,
          consecutiveAbsences: 1,
          lastSeenAt: daysAgo(2),
        });
      }
      await db
        .update(jobs)
        .set({ embedding: oneHot(0), contentSignature: "stored-sig" })
        .where(eq(jobs.companyId, sr));
      // sr-2 is brand new and its detail 500s too; sr-3 hydrates normally.
      installFetch(
        srBoard("srco", ["sr-1", "sr-2", "sr-3", "sr-4"], (id) =>
          id === "sr-4"
            ? jsonResponse(null)
            : id === "sr-3"
              ? jsonResponse(srDetail(id))
              : textResponse("err", 500),
        ),
      );
      const freshSince = new Date(Date.now() - 1_000);

      const counts = await runIngestion(db, { paceMs: 0, adapter: NO_RETRY });

      expect(counts).toMatchObject({ ok: 1, failed: 0, jobs: 1, changed: 1, hydrateSkipped: 3 });
      expect(counts).toMatchObject({ swept: 0, wouldClose: 0, markFailed: 0 });
      for (const id of ["sr-1", "sr-4"]) {
        const kept = (await jobByExt(id))!;
        // Never overwritten with the list-level title / placeholder "" — so the embedding is never NULLed
        // (no paid re-embed) and the signature never recomputed from the title alone.
        expect(kept.title).toBe("seeded job");
        expect(kept.descriptionText).toBe(`Stored ${id}`);
        expect(kept.contentSignature).toBe("stored-sig");
        expect(kept.embedding).not.toBeNull();
        // Still PRESENT: the sweep reset its streak (an absent job's would grow to 2) and markJobsPresent
        // refreshed last_seen_at (so the staleness timer never ages a live job).
        expect(kept.lifecycleState).toBe("active");
        expect(kept.consecutiveAbsences).toBe(0);
        expect(kept.lastSeenAt.getTime()).toBeGreaterThanOrEqual(freshSince.getTime());
      }
      expect(await jobByExt("sr-2")).toBeUndefined(); // no content yet — waits for a run that fetches it
      expect((await jobByExt("sr-3"))!.descriptionText).toBe("About sr-3");
      // Persisted with the run row, so `pnpm runs` shows it.
      expect((await allSourceRuns())[0]!.counts).toMatchObject({ hydrateSkipped: 3, hydrateListed: 4 });
    });

    it("a board whose EVERY detail fetch failed writes nothing yet is still present and certified", async () => {
      // The presence gate keys on the LISTING, not on rows written: total is 0 here, but the list was fetched.
      const sr = await seedCompany({
        slug: "srdown",
        source: "smartrecruiters",
        active: true,
        lastIngestedAt: null,
      });
      await seedJob(sr, {
        externalId: "d-1",
        source: "smartrecruiters",
        descriptionText: "Stored d-1",
        consecutiveAbsences: 1,
        lastSeenAt: daysAgo(2),
      });
      installFetch(srBoard("srdown", ["d-1"], () => textResponse("err", 503)));

      const boards: IngestBoardResult[] = [];
      const counts = await runIngestion(db, {
        paceMs: 0,
        adapter: NO_RETRY,
        onBoard: (b) => boards.push(b),
      });

      expect(counts).toMatchObject({ ok: 1, jobs: 0, changed: 0, hydrateSkipped: 1, swept: 0 });
      // The per-board result says so too — `ingest:all` prints it, so this board doesn't read as empty.
      expect(boards[0]).toMatchObject({ ok: true, jobs: 0, hydrateSkipped: 1 });
      const kept = (await jobByExt("d-1"))!;
      expect(kept.descriptionText).toBe("Stored d-1");
      expect(kept.consecutiveAbsences).toBe(0);
      expect(kept.lastSeenAt.getTime()).toBeGreaterThan(daysAgo(1).getTime());
      expect((await companyById(sr)).lastIngestedAt).toBeInstanceOf(Date);
    });

    it("counts DISTINCT postings, never one whose duplicate copy was written", async () => {
      await seedCompany({ slug: "srdup", source: "smartrecruiters", active: true });
      // dup-1 is listed twice: one copy's detail fails, the other's succeeds → written, not counted.
      // dup-2 is listed twice and both details fail → counted ONCE.
      let dup1Calls = 0;
      installFetch(
        srBoard("srdup", ["dup-1", "dup-1", "dup-2", "dup-2"], (id) =>
          id === "dup-1" && dup1Calls++ > 0 ? jsonResponse(srDetail(id)) : textResponse("err", 500),
        ),
      );

      const counts = await runIngestion(db, { paceMs: 0, adapter: NO_RETRY });

      expect(dup1Calls).toBe(2); // both dup-1 copies were hydrated (one failed, one didn't)
      expect(counts).toMatchObject({ ok: 1, jobs: 1, hydrateSkipped: 1 });
      expect((await jobByExt("dup-1"))!.descriptionText).toBe("About dup-1");
      expect(await jobByExt("dup-2")).toBeUndefined();
    });

    it("counts nothing for a board whose write failed — the board fails, and hydrateSkipped stays 0", async () => {
      await seedCompany({ slug: "srfail", source: "smartrecruiters", active: true });
      installFetch(
        srBoard("srfail", ["f-1", "f-2"], (id) =>
          id === "f-2" ? jsonResponse(srDetail(id)) : textResponse("err", 500),
        ),
      );
      // A failed write as drizzle throws it: the SQL + params message, the Postgres reason on `cause`.
      const cause = Object.assign(new Error("value too long for type character varying(255)"), {
        code: "22001",
      });
      vi.mocked(upsertJobs).mockRejectedValueOnce(
        new DrizzleQueryError('insert into "jobs" ("id") values ($1)', ["f-2"], cause),
      );

      const counts = await runIngestion(db, { paceMs: 0, adapter: NO_RETRY });

      // The write WAS attempted, with f-1 flagged. Assert on mock.calls, never a toHaveBeenCalled*
      // matcher on these repo spies: its failure message prints the call's `db` argument (the whole
      // PGlite instance) and runs the worker out of heap instead of failing cleanly.
      expect(vi.mocked(upsertJobs).mock.calls.length).toBe(1);
      const attempted = vi.mocked(upsertJobs).mock.calls[0]![2];
      expect(attempted.filter((j) => j.contentMissing).map((j) => j.externalId)).toEqual(["f-1"]);
      expect(counts).toMatchObject({ ok: 0, failed: 1, jobs: 0, hydrateSkipped: 0 });
      // The recorded error leads with the Postgres reason, and drizzle's params line is gone.
      expect((await allSourceRuns())[0]!.errorSample).toBe(
        'smartrecruiters:srfail [code=22001] value too long for type character varying(255) | ' +
          'Failed query: insert into "jobs" ("id") values ($1)',
      );
    });
  });

  describe("an inline-content board serving a blank description (the empty-description guard)", () => {
    it("keeps the stored text and never NULLs the embedding", async () => {
      // Greenhouse (content=true) — no hydrate, so no contentMissing flag: only the upsertJobs guard stands
      // between a momentarily-blank `content` and the stored description.
      const gh = await seedCompany({ slug: "inline", active: true });
      // Same title as ghJob(1), so only the description differs (a title change would rightly re-embed).
      await seedJob(gh, { externalId: "1", title: "Job 1", descriptionText: "Stored body" });
      await db.update(jobs).set({ embedding: oneHot(1) }).where(eq(jobs.companyId, gh));
      installFetch([boardRoute("inline", [ghJob(1)])]); // ghJob carries no `content` ⇒ descriptionText ""

      const counts = await runIngestion(db, { paceMs: 0, adapter: NO_RETRY });

      expect(counts).toMatchObject({ ok: 1, jobs: 1, hydrateSkipped: 0 });
      expect(counts.hydrateListed).toBe(0); // Greenhouse doesn't hydrate: no health-ratio denominator
      const kept = (await jobByExt("1"))!;
      expect(kept.descriptionText).toBe("Stored body");
      expect(kept.embedding).not.toBeNull();
    });
  });

  describe("a failed detail fetch across runs (enforce): the posting stays live, moved boards included", () => {
    // ABSENCE_CLOSE_THRESHOLD (3) enforced sweeps close an absent job, so three runs prove the outcome.
    const RUNS = 3;
    async function runTimes(n: number): Promise<IngestionCounts[]> {
      const all: IngestionCounts[] = [];
      for (let i = 0; i < n; i++) {
        all.push(await runIngestion(db, { paceMs: 0, adapter: NO_RETRY, enforceLifecycle: true }));
      }
      return all;
    }

    it("a posting that MOVED boards and whose detail fails moves to the new board and stays live (never closed)", async () => {
      // srold (lower id, processed first) listed mv-1 before; now only srnew lists it — and its detail 500s.
      const oldBoard = await seedCompany({ slug: "srold", source: "smartrecruiters", active: true });
      const newBoard = await seedCompany({ slug: "srnew", source: "smartrecruiters", active: true });
      await seedJob(oldBoard, {
        externalId: "mv-1",
        source: "smartrecruiters",
        descriptionText: "Stored mv-1",
        lastSeenAt: daysAgo(2),
      });
      installFetch([
        ...srBoard("srold", ["keep-1"], (id) => jsonResponse(srDetail(id))),
        ...srBoard("srnew", ["mv-1"], () => textResponse("err", 500)),
      ]);

      const runs = await runTimes(RUNS);

      expect(runs.map((c) => c.hydrateSkipped)).toEqual([1, 1, 1]);
      expect(runs.reduce((n, c) => n + c.closed, 0)).toBe(0);
      const moved = (await jobByExt("mv-1"))!;
      // Its company_id followed the listing: the board that lists it NOW owns it, so markJobsPresent
      // (company-scoped) stamps it and the OLD board's sweep no longer sees it as its absent posting.
      expect(moved.companyId).toBe(newBoard);
      expect(moved.lifecycleState).toBe("active");
      expect(moved.consecutiveAbsences).toBe(0);
      expect(moved.lastSeenAt.getTime()).toBeGreaterThan(daysAgo(1).getTime());
      expect(moved.descriptionText).toBe("Stored mv-1"); // content still never overwritten
    });

    it("a 404 or SR's 'Posting not available' detail is contentMissing like any failure: present, never closed", async () => {
      // The known limitation, pinned: while SR still LISTS the posting it stays open (content kept), however
      // many runs its detail is unavailable; hydrate_skip_ratio is what surfaces it.
      const sr = await seedCompany({ slug: "srunavail", source: "smartrecruiters", active: true });
      for (const id of ["g-404", "g-msg"]) {
        await seedJob(sr, { externalId: id, source: "smartrecruiters", descriptionText: `Stored ${id}` });
      }
      installFetch(
        srBoard("srunavail", ["g-404", "g-msg"], (id) =>
          id === "g-404" ? textResponse("missing", 404) : jsonResponse({ message: "Posting not available" }),
        ),
      );

      const runs = await runTimes(RUNS);

      expect(runs.map((c) => c.hydrateSkipped)).toEqual([2, 2, 2]);
      for (const id of ["g-404", "g-msg"]) {
        const kept = (await jobByExt(id))!;
        expect(kept.lifecycleState).toBe("active");
        expect(kept.consecutiveAbsences).toBe(0);
        expect(kept.descriptionText).toBe(`Stored ${id}`);
      }
    });
  });

  describe("politeness pacing — per pacing key, ≥ paceMs after that key's previous board FINISHED", () => {
    // Each board's fetch records `fetch:<slug>` and advances the injected fake clock by `tookMs` (the
    // board's duration); the stubbed sleep advances it by what it slept. DB work takes 0 fake ms.
    const record =
      (slug: string, body: unknown, tookMs: number) =>
      (): Response => {
        paced.events.push(`fetch:${slug}`);
        paced.now += tookMs;
        return jsonResponse(body);
      };
    const gh = (slug: string, tookMs = 0): Route => ({
      match: boardMatch(slug),
      respond: record(slug, { jobs: [] }, tookMs),
    });
    const lever = (slug: string, tookMs = 0): Route => ({
      match: (url) => url.includes(`api.lever.co/v0/postings/${slug}?`),
      respond: record(slug, [], tookMs), // Lever's envelope is a bare array
    });
    const clocked = { paceMs: 500, adapter: NO_RETRY, clock: () => paced.now };

    it("instant same-key neighbours get the full pause; a source change starts at once", async () => {
      // id order: greenhouse, greenhouse, lever, lever, greenhouse — every board instant (0 ms).
      await seedCompany({ slug: "pa", active: true });
      await seedCompany({ slug: "pb", active: true });
      await seedCompany({ slug: "pc", source: "lever", active: true });
      await seedCompany({ slug: "pd", source: "lever", active: true });
      await seedCompany({ slug: "pe", active: true });
      installFetch([gh("pa"), gh("pb"), lever("pc"), lever("pd"), gh("pe")]);

      const counts = await runIngestion(db, clocked);

      expect(counts).toMatchObject({ processed: 5, ok: 5, failed: 0 });
      // pa→pb and pc→pd wait the whole 500; pe follows pb's finish by the 500 slept for pd ⇒ no wait.
      expect(paced.events).toEqual([
        "fetch:pa",
        "sleep:500",
        "fetch:pb",
        "fetch:pc",
        "sleep:500",
        "fetch:pd",
        "fetch:pe",
      ]);
    });

    it("ALTERNATING sources can't burst one host: each key waits only the remainder since its last finish", async () => {
      // greenhouse, lever, greenhouse, lever, greenhouse — every board takes 100 ms. Adjacency-only pacing
      // would never sleep here and greenhouse would see a board start 100 ms after the last one finished.
      await seedCompany({ slug: "aa", active: true });
      await seedCompany({ slug: "ab", source: "lever", active: true });
      await seedCompany({ slug: "ac", active: true });
      await seedCompany({ slug: "ad", source: "lever", active: true });
      await seedCompany({ slug: "ae", active: true });
      installFetch([gh("aa", 100), lever("ab", 100), gh("ac", 100), lever("ad", 100), gh("ae", 100)]);

      await runIngestion(db, clocked);

      // aa 0→100, ab 100→200, ac: 100 since aa finished ⇒ sleep 400 ⇒ 600→700, ad: 500 since ab finished
      // ⇒ no wait ⇒ 700→800, ae: 100 since ac finished ⇒ sleep 400 ⇒ 1200.
      expect(paced.events).toEqual([
        "fetch:aa",
        "fetch:ab",
        "sleep:400",
        "fetch:ac",
        "fetch:ad",
        "sleep:400",
        "fetch:ae",
      ]);
    });

    it("a SLOW board is followed by the full gap after it FINISHES before the next same-key board", async () => {
      // sa takes 800 ms. Measured from its START the next greenhouse board could go at once (800 ≥ 500);
      // measured from its FINISH — the old "≥ paceMs after the previous board" — it must still wait 500.
      await seedCompany({ slug: "fa", active: true });
      await seedCompany({ slug: "fb", active: true });
      installFetch([gh("fa", 800), gh("fb")]);

      await runIngestion(db, clocked);

      expect(paced.events).toEqual(["fetch:fa", "sleep:500", "fetch:fb"]);
    });

    it("a FAILED board counts as finished for its key too (the host was still hit)", async () => {
      await seedCompany({ slug: "xa", active: true });
      await seedCompany({ slug: "xb", active: true });
      installFetch([
        {
          match: boardMatch("xa"),
          respond: () => {
            paced.events.push("fetch:xa");
            return textResponse("err", 500);
          },
        },
        gh("xb"),
      ]);

      const counts = await runIngestion(db, clocked);

      expect(counts).toMatchObject({ processed: 2, ok: 1, failed: 1 });
      expect(paced.events).toEqual(["fetch:xa", "sleep:500", "fetch:xb"]);
    });

    it("the same injected clock drives the maxRunMs budget (stop STARTING boards once it's spent)", async () => {
      const m1 = await seedCompany({ slug: "m1", active: true });
      const m2 = await seedCompany({ slug: "m2", source: "lever", active: true });
      await seedCompany({ slug: "m3", active: true });
      installFetch([gh("m1", 600), lever("m2", 600), gh("m3", 600)]);

      const counts = await runIngestion(db, { ...clocked, maxRunMs: 1000 });

      // m1 @0→600, m2 @600 (600 < 1000)→1200, m3: 1200 ≥ 1000 ⇒ never started; the cursor stops at m2.
      expect(counts).toMatchObject({ companies: 3, processed: 2, lastId: m2 });
      expect(paced.events).toEqual(["fetch:m1", "fetch:m2"]);
      expect(m1).toBeLessThan(m2);
    });

    it("a slow board in between means no pause at all", async () => {
      await seedCompany({ slug: "sa", active: true });
      await seedCompany({ slug: "sb", source: "lever", active: true });
      await seedCompany({ slug: "sc", active: true });
      installFetch([gh("sa"), lever("sb", 800), gh("sc")]); // 800 ms since sa finished ≥ 500

      await runIngestion(db, clocked);

      expect(paced.events).toEqual(["fetch:sa", "fetch:sb", "fetch:sc"]);
    });

    it("paces by the adapter's pacingKey: two sources declaring one key share the clock", async () => {
      // Simulate two sources on one vendor's host: lever declares greenhouse's key for this test.
      const leverAdapter = adapters.lever as { pacingKey?: string };
      leverAdapter.pacingKey = "greenhouse";
      try {
        await seedCompany({ slug: "ka", active: true });
        await seedCompany({ slug: "kb", source: "lever", active: true });
        installFetch([gh("ka"), lever("kb")]);

        await runIngestion(db, clocked);

        // A source change, yet the shared key makes lever wait out greenhouse's 500.
        expect(paced.events).toEqual(["fetch:ka", "sleep:500", "fetch:kb"]);
      } finally {
        delete leverAdapter.pacingKey;
      }
    });

    it("Workable paces at 1000 ms; every other adapter keeps the default 500", async () => {
      // No paceMs passed: greenhouse gets the run's default, Workable its key's slower pace.
      await seedCompany({ slug: "ga", active: true });
      await seedCompany({ slug: "gb", active: true });
      await seedCompany({ slug: "wa", source: "workable", active: true });
      await seedCompany({ slug: "wb", source: "workable", active: true });
      installFetch([gh("ga"), gh("gb"), workableBoard("wa", 200), workableBoard("wb", 200)]);

      await runIngestion(db, { adapter: NO_RETRY, clock: () => paced.now });

      expect(paced.events).toEqual([
        "fetch:ga",
        "sleep:500",
        "fetch:gb",
        "fetch:wa",
        "sleep:1000",
        "fetch:wb",
      ]);
    });

    it("resolves the pace per KEY: an adapter sharing Workable's key paces at Workable's 1000", async () => {
      const leverAdapter = adapters.lever as { pacingKey?: string };
      leverAdapter.pacingKey = "workable"; // lever declares no paceMs of its own
      try {
        await seedCompany({ slug: "la", source: "lever", active: true });
        await seedCompany({ slug: "lb", source: "lever", active: true });
        installFetch([lever("la"), lever("lb")]);

        await runIngestion(db, { adapter: NO_RETRY, clock: () => paced.now });

        expect(paced.events).toEqual(["fetch:la", "sleep:1000", "fetch:lb"]);
      } finally {
        delete leverAdapter.pacingKey;
      }
    });

    it("the caller's paceMs is a floor: a slower run pace applies to every key, Workable's included", async () => {
      await seedCompany({ slug: "ga", active: true });
      await seedCompany({ slug: "gb", active: true });
      await seedCompany({ slug: "wa", source: "workable", active: true });
      await seedCompany({ slug: "wb", source: "workable", active: true });
      installFetch([gh("ga"), gh("gb"), workableBoard("wa", 200), workableBoard("wb", 200)]);

      await runIngestion(db, { paceMs: 1500, adapter: NO_RETRY, clock: () => paced.now });

      expect(paced.events).toEqual([
        "fetch:ga",
        "sleep:1500",
        "fetch:gb",
        "fetch:wa",
        "sleep:1500",
        "fetch:wb",
      ]);
    });
  });

  describe("rate-limit cooldown — per pacing key, Worker fail-fast mode", () => {
    // Every board's fetch records `fetch:<slug>` (beside the stubbed `sleep:<ms>`) and advances the fake
    // clock by `tookMs`, so the exact event list shows which boards made a request and which paused.
    const ghBoard = (slug: string, tookMs = 0): Route => ({
      match: boardMatch(slug),
      respond: () => {
        paced.events.push(`fetch:${slug}`);
        paced.now += tookMs;
        return jsonResponse({ jobs: [] });
      },
    });
    // The Worker's mode: fail fast on any wait over 5 s (no retries keeps the tests instant).
    const FAIL_FAST = { maxRetries: 0, maxRetryWaitMs: 5000 };
    const clocked = { adapter: FAIL_FAST, clock: () => paced.now };

    it("skips the key's boards inside the window: no request, no pause, no presence, not failed — other keys run", async () => {
      await seedCompany({ slug: "wa", source: "workable", active: true });
      await seedCompany({ slug: "g1", active: true });
      const wb = await seedCompany({ slug: "wb", source: "workable", active: true, lastIngestedAt: null });
      await seedCompany({ slug: "g2", active: true });
      const wc = await seedCompany({ slug: "wc", source: "workable", active: true });
      // wb's stored job is on its listing: had wb been fetched, it would be stamped present and wb certified.
      await seedJob(wb, {
        externalId: "w1",
        source: "workable",
        consecutiveAbsences: 1,
        lastSeenAt: daysAgo(2),
      });
      const fx = installFetch([
        workableBoard("wa", 429, [], "120"),
        ghBoard("g1"),
        workableBoard("wb", 200, [wkJob("w1")]),
        ghBoard("g2"),
        workableBoard("wc", 200),
      ]);
      const boards: IngestBoardResult[] = [];
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      let counts: IngestionCounts;
      try {
        counts = await runIngestion(db, { ...clocked, onBoard: (b) => boards.push(b) });
        expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
          "2 ok, 1 failed, 2 rate-limit-skipped",
        );
      } finally {
        log.mockRestore();
      }

      // wb and wc: no request and no pacing sleep. g1 → g2 still waits greenhouse's 500.
      expect(fx.calls).toHaveLength(3);
      expect(paced.events).toEqual(["fetch:wa", "fetch:g1", "sleep:500", "fetch:g2"]);
      // Skipped boards are processed, so the cursor moves past them; only the 429'd board failed.
      expect(counts).toMatchObject({
        companies: 5,
        processed: 5,
        ok: 2,
        failed: 1,
        rateLimitSkipped: 2,
        lastId: wc,
      });
      // Each board reported once, with its final outcome: the ones a rate limit cost after the second pass.
      expect(boards.map((b) => [b.slug, b.ok, b.skipped])).toEqual([
        ["g1", true, undefined],
        ["g2", true, undefined],
        ["wa", false, undefined],
        ["wb", false, "rate-limited"],
        ["wc", false, "rate-limited"],
      ]);
      expect(boards[2]!.error).toBe('workable "wa" rate-limited: 429, retry after 120s');
      expect(boards[3]!.error).toBeUndefined();
      // No presence stamp, no sweep, no certification.
      const w1 = (await jobByExt("w1"))!;
      expect(w1.consecutiveAbsences).toBe(1);
      expect(w1.lastSeenAt.getTime()).toBeLessThan(daysAgo(1).getTime());
      expect((await companyById(wb)).lastIngestedAt).toBeNull();
      // Persisted with the run row, which `pnpm runs` prints verbatim.
      expect((await allSourceRuns())[0]!.counts).toMatchObject({ failed: 1, rateLimitSkipped: 2 });
    });

    it.each([
      ["inside the Retry-After", "120", 119_000, false],
      ["past the Retry-After", "120", 121_000, true],
      ["inside the 60 s floor", "1", 59_000, false],
      ["past the 10 min cap", "3600", 601_000, true],
    ])(
      "cools down for the Retry-After clamped to [60 s, 10 min]: next board %s (Retry-After %s) → attempted %s",
      async (_when, retryAfter, gapMs, attempted) => {
        await seedCompany({ slug: "wa", source: "workable", active: true });
        await seedCompany({ slug: "g1", active: true });
        await seedCompany({ slug: "wb", source: "workable", active: true });
        installFetch([workableBoard("wa", 429, [], retryAfter), ghBoard("g1", gapMs), workableBoard("wb", 200)]);

        const counts = await runIngestion(db, clocked);

        // Once cooled, wa (429'd itself) is retried by the second pass too — and 429s again, still one failure.
        expect(paced.events).toEqual(
          attempted
            ? ["fetch:wa", "fetch:g1", "fetch:wb", "sleep:1000", "fetch:wa"]
            : ["fetch:wa", "fetch:g1"],
        );
        expect(counts).toMatchObject({ processed: 3, failed: 1, rateLimitSkipped: attempted ? 0 : 1 });
      },
    );

    it("the CLI path (no maxRetryWaitMs) never skips: a 429 is an ordinary failed board", async () => {
      await seedCompany({ slug: "wa", source: "workable", active: true });
      await seedCompany({ slug: "wb", source: "workable", active: true });
      installFetch([workableBoard("wa", 429, [], "120"), workableBoard("wb", 200)]);

      const counts = await runIngestion(db, { adapter: NO_RETRY, clock: () => paced.now });

      expect(paced.events).toEqual(["fetch:wa", "sleep:1000", "fetch:wb"]);
      expect(counts).toMatchObject({ ok: 1, failed: 1, rateLimitSkipped: 0 });
    });

    it("a rate-limited DETAIL fetch cools the key down too; its unhydrated postings count in hydrateSkipped", async () => {
      await seedCompany({ slug: "sr1", source: "smartrecruiters", active: true });
      await seedCompany({ slug: "sr2", source: "smartrecruiters", active: true });
      // sr1: h-1's detail really fails (500); h-2's is rate-limited, so the pool stops before h-3.
      const fx = installFetch([
        ...srBoard("sr1", ["h-1", "h-2", "h-3"], (id) =>
          id === "h-1"
            ? textResponse("err", 500)
            : new Response(null, { status: 429, headers: { "retry-after": "120" } }),
        ),
        ...srBoard("sr2", ["h-4"], (id) => jsonResponse(srDetail(id))),
      ]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let counts: IngestionCounts;
      try {
        counts = await runIngestion(db, { ...clocked, adapter: { ...FAIL_FAST, hydrateConcurrency: 1 } });
      } finally {
        warn.mockRestore();
      }

      // sr1: its list + h-1 + h-2 (h-3 never fetched); sr2: nothing.
      expect(fx.calls).toHaveLength(3);
      expect(fx.calls.some((u) => u.includes("/companies/sr2/"))).toBe(false);
      // All three unhydrated postings count, so hydrate_skip_ratio sees persistent detail throttling.
      expect(counts).toMatchObject({
        ok: 1,
        failed: 0,
        rateLimitSkipped: 1,
        hydrateSkipped: 3,
        hydrateListed: 3,
      });
    });

    it("second pass: a blip is recovered in-tick — the 429'd board and the skipped one are retried once cooled", async () => {
      await seedCompany({ slug: "wa", source: "workable", active: true });
      const wb = await seedCompany({ slug: "wb", source: "workable", active: true, lastIngestedAt: null });
      await seedCompany({ slug: "g1", active: true });
      const g2 = await seedCompany({ slug: "g2", active: true });
      let waCalls = 0;
      installFetch([
        {
          // A blip: wa's first fetch is 429'd, its retry succeeds.
          match: (url) => url.includes("/widget/accounts/wa?"),
          respond: () => {
            paced.events.push("fetch:wa");
            return ++waCalls === 1
              ? new Response(null, { status: 429, headers: { "retry-after": "60" } })
              : jsonResponse({ jobs: [] });
          },
        },
        workableBoard("wb", 200, [wkJob("w1")]),
        ghBoard("g1", 61_000), // the main loop ends 61 s in: past wa's 60 s cooldown
        failRoute("g2", 500), // a real failure, later in id order than wa's recovered 429
      ]);
      const boards: IngestBoardResult[] = [];

      const counts = await runIngestion(db, { ...clocked, onBoard: (b) => boards.push(b) });

      // wa failed and wb was skipped, in order; both were fetched after g1 and g2 (paced by Workable's 1000).
      expect(paced.events).toEqual([
        "fetch:wa",
        "fetch:g1",
        "sleep:500", // g2 (its 500 isn't recorded)
        "fetch:wa",
        "sleep:1000",
        "fetch:wb",
      ]);
      // Each board counted once, by its FINAL outcome; the cursor stays where the main loop left it.
      expect(counts).toMatchObject({
        companies: 4,
        processed: 4,
        ok: 3,
        failed: 1,
        rateLimitSkipped: 0,
        lastId: g2,
      });
      // Reported once each, with that final outcome.
      expect(boards.map((b) => [b.slug, b.ok])).toEqual([
        ["g1", true],
        ["g2", false],
        ["wa", true],
        ["wb", true],
      ]);
      // The recovered 429 leaves no errorSample: the real later failure's message is it.
      expect((await allSourceRuns())[0]!.errorSample).toMatch(/^greenhouse:g2 .*500/);
      // Its lifecycle ran as normal: stamped present and certified.
      expect((await companyById(wb)).lastIngestedAt).toBeInstanceOf(Date);
    });

    it("a recovered 429 alone leaves no errorSample", async () => {
      await seedCompany({ slug: "wa", source: "workable", active: true });
      await seedCompany({ slug: "g1", active: true });
      let waCalls = 0;
      installFetch([
        {
          match: (url) => url.includes("/widget/accounts/wa?"),
          respond: () =>
            ++waCalls === 1
              ? new Response(null, { status: 429, headers: { "retry-after": "60" } })
              : jsonResponse({ jobs: [] }),
        },
        ghBoard("g1", 61_000),
      ]);

      const counts = await runIngestion(db, clocked);

      expect(counts).toMatchObject({ ok: 2, failed: 0 });
      expect((await allSourceRuns())[0]!.errorSample).toBeNull();
    });

    it("second pass: a board whose detail fetches a 429 stopped is re-run once cooled — and swept only once", async () => {
      const sr = await seedCompany({ slug: "sr1", source: "smartrecruiters", active: true });
      await seedCompany({ slug: "g1", active: true });
      // A stored posting sr1 no longer lists: each sweep adds one to its absence streak.
      await seedJob(sr, { externalId: "gone-1", source: "smartrecruiters", consecutiveAbsences: 0 });
      let h1Calls = 0;
      const fx = installFetch([
        ...srBoard("sr1", ["h-1", "h-2"], (id) =>
          id === "h-1" && ++h1Calls === 1
            ? new Response(null, { status: 429, headers: { "retry-after": "60" } })
            : jsonResponse(srDetail(id)),
        ),
        ghBoard("g1", 61_000), // past sr1's 60 s cooldown
      ]);
      const boards: IngestBoardResult[] = [];
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let counts: IngestionCounts;
      try {
        counts = await runIngestion(db, {
          ...clocked,
          adapter: { ...FAIL_FAST, hydrateConcurrency: 1 },
          onBoard: (b) => boards.push(b),
        });
      } finally {
        warn.mockRestore();
      }

      // sr1: list + h-1 (429, the pool stops); g1; then sr1 again: list + h-1 + h-2.
      expect(fx.calls.filter((u) => u.includes("/companies/sr1/"))).toHaveLength(5);
      // Its final outcome is the re-run's: fully hydrated.
      expect(counts).toMatchObject({ ok: 2, failed: 0, jobs: 2, hydrateSkipped: 0, hydrateListed: 2 });
      expect(boards.map((b) => [b.slug, b.hydrateSkipped])).toEqual([
        ["g1", 0],
        ["sr1", 0],
      ]);
      // Swept once this tick, not twice.
      expect((await jobByExt("gone-1"))!.consecutiveAbsences).toBe(1);
    });

    it("second pass: stops once the budget is spent — the rest stay skipped", async () => {
      await seedCompany({ slug: "wa", source: "workable", active: true });
      await seedCompany({ slug: "wb", source: "workable", active: true });
      await seedCompany({ slug: "g1", active: true });
      installFetch([
        workableBoard("wa", 429, [], "60"),
        workableBoard("wb", 200),
        ghBoard("g1", 61_000),
      ]);

      const counts = await runIngestion(db, { ...clocked, maxRunMs: 30_000 });

      expect(paced.events).toEqual(["fetch:wa", "fetch:g1"]);
      expect(counts).toMatchObject({ processed: 3, ok: 1, failed: 1, rateLimitSkipped: 1 });
    });
  });

  describe("a poison row (a company whose source has no adapter)", () => {
    it("fails only its own board — the others process and the cursor advances past it", async () => {
      const p1 = await seedCompany({ slug: "p1", active: true });
      const p2 = await seedCompany({ slug: "p2", source: "nonesuch" as SourceName, active: true });
      const p3 = await seedCompany({ slug: "p3", active: true });
      installFetch([boardRoute("p1", [ghJob(1)]), boardRoute("p3", [ghJob(3)])]);

      // Default pacing (no paceMs override): nothing about p2 — its adapter lookup included — may throw
      // outside its own board's try.
      const boards: IngestBoardResult[] = [];
      const counts = await runIngestion(db, {
        adapter: NO_RETRY,
        clock: () => paced.now,
        onBoard: (b) => boards.push(b),
      });

      expect(counts).toMatchObject({ companies: 3, processed: 3, ok: 2, failed: 1, lastId: p3 });
      expect((await jobsFor(p1)).length).toBe(1);
      expect((await jobsFor(p3)).length).toBe(1);
      expect(p2).toBeGreaterThan(p1);
      const runs = await allSourceRuns();
      expect(runs[0]!.status).toBe("ok"); // isolated, not an infrastructural failure
      // A clear, shape-only cause (no opaque TypeError), exactly.
      expect(runs[0]!.errorSample).toBe('nonesuch:p2 unknown source "nonesuch"');
      expect(boards[1]).toMatchObject({ slug: "p2", ok: false, error: 'unknown source "nonesuch"' });
    });
  });

  describe("company id from listCompanies (no per-board upsertCompany)", () => {
    it("never calls upsertCompany, lands jobs on the listed id, and leaves the companies rows unchanged", async () => {
      const full = await seedCompany({ slug: "fullco", active: true });
      const bare = await seedCompany({ slug: "bareco", active: true });
      installFetch([boardRoute("fullco", [ghJob(1)]), boardRoute("bareco", [])]);
      const xminOf = async (id: number): Promise<string> => {
        const rows = await db
          .select({ xmin: sql<string>`xmin::text` })
          .from(companies)
          .where(eq(companies.id, id));
        return rows[0]!.xmin;
      };
      const before = await db.select().from(companies).orderBy(companies.id);
      const bareXmin = await xminOf(bare);

      const counts = await runIngestion(db, { paceMs: 0, adapter: NO_RETRY });

      expect(counts).toMatchObject({ ok: 2, failed: 0, jobs: 1 });
      expect(vi.mocked(upsertCompany).mock.calls.length).toBe(0); // (mock.calls — see the failed-write test)
      expect((await jobsFor(full)).map((j) => j.externalId)).toEqual(["1"]);
      // The DB state the old path produced (its upsert wrote no column): no row added, nothing changed bar
      // the last_ingested_at markCompanyIngested stamps on the non-empty board...
      const after = await db.select().from(companies).orderBy(companies.id);
      const sansIngested = (rows: typeof before) =>
        rows.map(({ lastIngestedAt: _stamped, ...rest }) => rest);
      expect(sansIngested(after)).toEqual(sansIngested(before));
      // ...and the empty board's row was not written AT ALL: same tuple version. The old no-op
      // `ON CONFLICT DO UPDATE SET slug = excluded.slug` wrote a new version — a dead tuple — every tick.
      expect(await xminOf(bare)).toBe(bareXmin);
    });
  });
});
