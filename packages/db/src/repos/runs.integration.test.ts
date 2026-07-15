import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  failStaleRuns,
  finishDigestRun,
  finishRun,
  startDigestRun,
  startRun,
} from "@opusfinder/db/repos";
import { digestRuns, sourceRuns } from "@opusfinder/db/schema";

import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";

// The run lifecycle for BOTH audit tables under REAL Postgres semantics: startRun/startDigestRun
// insert a `running` row off the column defaults, the shared finishRunRow terminalizes it exactly
// ONCE (the `status = 'running'` WHERE guard), and startRun's failStaleRuns sweep flips only
// genuinely-zombie rows. finishRunRow is exercised through its public wrappers (finishRun /
// finishDigestRun) — the realistic call shapes. NOT this file's job: SQL text/param binding (unit
// suites via render()/stubExecDb()), errorSample truncation (callers slice to 500 chars before the
// repo sees it), digest recipient/header/item behavior (the digests suite), or the companies
// staleness lifecycle also living in ./discovery (the discovery suite).
describe("run lifecycle (source_runs + digest_runs) — start opens a running row; finish terminalizes it exactly once (integration: real PGlite semantics)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    await truncate(db, sourceRuns, digestRuns);
  });
  afterAll(async () => {
    // Optional-chained: if beforeAll's createTestDb() rejected, a bare close() would bury the real
    // failure under a secondary TypeError. Drains the WASM handle → clean Windows teardown.
    await close?.();
  });

  // RUN-1 — every asserted column differs from its seeded default (running / NULL / {} / NULL), so
  // dropping any single .set() member in finishRunRow flips exactly one assertion red.
  it("terminalizes a running source_runs row — status, finished_at, counts, and error_sample all flip from their seeded defaults", async () => {
    const runId = await startRun(db, "ingestion", { source: "greenhouse" });
    await finishRun(db, runId, {
      status: "error",
      counts: { boards: 3, failed: 1 },
      errorSample: "HTTP 500 from first board",
    });

    const rows = await db.select().from(sourceRuns).where(eq(sourceRuns.id, runId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe("error"); // seeded default is 'running' — a dropped status member leaves it
    expect(row.finishedAt).toBeInstanceOf(Date); // NULL → non-NULL proves the now() stamp landed
    // >= not strict >: PGlite now() is per-statement, so insert + update can tie on the same ms.
    expect(row.finishedAt!.getTime()).toBeGreaterThanOrEqual(row.startedAt.getTime());
    expect(row.counts).toEqual({ boards: 3, failed: 1 }); // {} default survives a dropped counts member
    expect(row.errorSample).toBe("HTTP 500 from first board"); // persisted verbatim (callers pre-truncate)
  });

  // RUN-2 — the second call differs on EVERY column (and omits errorSample, so the ?? null would
  // visibly wipe 'boom'): if eq(status, 'running') were dropped from the WHERE, the second UPDATE
  // matches by id alone — status/counts/errorSample flip deterministically (finishedAt too, unless
  // the two statements happen to tie at millisecond precision).
  it("ignores a second finish on an already-terminal row — never clobbers the recorded status, counts, error_sample, or finished_at", async () => {
    const runId = await startRun(db, "discovery");
    await finishRun(db, runId, { status: "error", counts: { candidates: 7 }, errorSample: "boom" });

    const firstRows = await db.select().from(sourceRuns).where(eq(sourceRuns.id, runId));
    expect(firstRows).toHaveLength(1);
    const firstFinishedAtMs = firstRows[0]!.finishedAt!.getTime();

    // Second finish with DIFFERENT values on every column; errorSample omitted on purpose.
    await finishRun(db, runId, { status: "ok", counts: { candidates: 999 } });

    const rows = await db.select().from(sourceRuns).where(eq(sourceRuns.id, runId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe("error"); // 'ok' landing = the once-only status guard is gone
    expect(row.counts).toEqual({ candidates: 7 }); // 999 landing = same regression, counts lane
    expect(row.errorSample).toBe("boom"); // NULL here = the ?? null wiped it through a dead guard
    expect(row.finishedAt!.getTime()).toBe(firstFinishedAtMs); // a re-stamp = the UPDATE ran twice
  });

  // RUN-3 — B is ALSO status='running', so it satisfies every other predicate; only eq(id, runId)
  // protects it. Seeding B as already-terminal would be vacuous (the status guard alone protects it).
  it("scopes the finish to the given run id — a concurrent still-running row is left untouched", async () => {
    const idA = await startRun(db, "ingestion", { source: "lever" });
    const idB = await startRun(db, "ingestion", { source: "ashby" });
    await finishRun(db, idA, { status: "ok", counts: { boards: 2 } });

    const aRows = await db.select().from(sourceRuns).where(eq(sourceRuns.id, idA));
    expect(aRows).toHaveLength(1);
    const a = aRows[0]!;
    expect(a.status).toBe("ok");
    expect(a.finishedAt).toBeInstanceOf(Date);
    expect(a.counts).toEqual({ boards: 2 });

    const bRows = await db.select().from(sourceRuns).where(eq(sourceRuns.id, idB));
    expect(bRows).toHaveLength(1);
    const b = bRows[0]!;
    expect(b.status).toBe("running"); // B terminalized = eq(table.id, runId) dropped from the WHERE
    expect(b.finishedAt).toBeNull(); // finished_at stamped on B = same missing-id-scope regression
    expect(b.counts).toEqual({}); // counts overwritten on B = same regression, jsonb lane
  });

  // RUN-4 — the ONLY coverage of the table-generic parameter with digestRuns: if finishDigestRun
  // stopped delegating (or passed the wrong table), the row stays 'running' and everything flips.
  it("terminalizes a digest_runs row through the same shared helper — once-only guard holds and trigger is untouched", async () => {
    const runId = await startDigestRun(db, "cron");
    await finishDigestRun(db, runId, { status: "ok", counts: { recipients: 4, dispatched: 4 } });
    // Late duplicate with different values on every column — must be a no-op on the digest table too
    // (the guard could regress per-table if the shared helper were ever split).
    await finishDigestRun(db, runId, { status: "error", counts: {}, errorSample: "late duplicate" });

    const rows = await db.select().from(digestRuns).where(eq(digestRuns.id, runId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe("ok"); // still 'running' = the digestRuns delegation is broken
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(row.counts).toEqual({ recipients: 4, dispatched: 4 });
    expect(row.errorSample).toBeNull(); // 'late duplicate' landing = the guard regressed on this table
    expect(row.trigger).toBe("cron"); // finish must never touch the start-half's trigger column
  });

  // RUN-5 — source='lever' discriminates the opts.source pass-through; the returned-id SELECT
  // discriminates the .returning({ id }) clause. The status/startedAt defaults are pinned to the
  // REPLAYED MIGRATION DDL (0003), not schema.ts's .default clauses — drizzle emits the `default`
  // keyword for omitted insert columns either way, so schema.ts↔migration parity is drizzle-kit
  // generate/check's concern, not provable here.
  it("opens a source_runs row off the column defaults — running status, stamped started_at, empty counts, and the source persisted", async () => {
    const before = new Date();
    const id = await startRun(db, "discovery", { source: "lever" });

    const rows = await db.select().from(sourceRuns).where(eq(sourceRuns.id, id));
    expect(rows).toHaveLength(1); // a row found by the RETURNED id proves .returning({ id }) works
    const row = rows[0]!;
    expect(row.pipeline).toBe("discovery");
    expect(row.source).toBe("lever"); // NULL here = the opts.source pass-through was dropped
    expect(row.status).toBe("running"); // the DB default from the replayed migration DDL (0003)
    // defaultNow stamped a recent started_at; ±2s tolerates JS-clock vs PGlite-now() skew.
    expect(row.startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 2_000);
    expect(row.startedAt.getTime()).toBeLessThanOrEqual(Date.now() + 2_000);
    expect(row.finishedAt).toBeNull();
    expect(row.counts).toEqual({}); // the jsonb NOT NULL DEFAULT '{}'
    expect(row.errorSample).toBeNull();
  });

  // RUN-6 — trigger='manual' discriminates .values({ trigger }) (a dropped member → NULL → NOT NULL
  // throw). status/startedAt pin digest_runs' OWN migration-DDL defaults (0007), independent of
  // source_runs' — same parity caveat as RUN-5: schema.ts clauses are not provable here.
  it("opens a digest_runs row off the column defaults — trigger persisted, running status, stamped started_at, empty counts", async () => {
    const before = new Date();
    const id = await startDigestRun(db, "manual");

    const rows = await db.select().from(digestRuns).where(eq(digestRuns.id, id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.trigger).toBe("manual"); // NOT NULL — a dropped .values({ trigger }) makes the insert throw
    expect(row.status).toBe("running"); // digest_runs' own migration-DDL default (0007), not source_runs'
    expect(row.startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 2_000);
    expect(row.startedAt.getTime()).toBeLessThanOrEqual(Date.now() + 2_000);
    expect(row.finishedAt).toBeNull();
    expect(row.counts).toEqual({});
    expect(row.errorSample).toBeNull();
  });

  // RUN-7 — two-sided: drop the failStaleRuns(db) call in startRun and the zombie stays 'running';
  // drop the started_at interval predicate and the FRESH running row gets swept. Seeding only the
  // stale row would leave the window-clause mutation undetected.
  it("sweeps a >60-min zombie 'running' row on startRun but protects a fresh running row via the interval window", async () => {
    // Direct inserts are legal here (no FKs): backdate the zombie's started_at 2h — DB time can't be
    // faked, so explicit timestamp control with a generous margin over the 60-min window is the lever.
    const zRows = await db
      .insert(sourceRuns)
      .values({ pipeline: "ingestion", startedAt: new Date(Date.now() - 2 * 3_600_000) })
      .returning({ id: sourceRuns.id });
    expect(zRows).toHaveLength(1);
    const zId = zRows[0]!.id;
    const fRows = await db
      .insert(sourceRuns)
      .values({ pipeline: "ingestion" }) // started_at defaults now() — fresh
      .returning({ id: sourceRuns.id });
    expect(fRows).toHaveLength(1);
    const fId = fRows[0]!.id;

    await startRun(db, "ingestion");

    const zAfter = await db.select().from(sourceRuns).where(eq(sourceRuns.id, zId));
    expect(zAfter).toHaveLength(1);
    const z = zAfter[0]!;
    expect(z.status).toBe("error"); // still 'running' = startRun no longer calls failStaleRuns
    expect(z.finishedAt).toBeInstanceOf(Date);
    // The exact fixed sample — a drifted message breaks the `pnpm runs` audit-trail signal.
    expect(z.errorSample).toBe(
      "swept: stale running row (process killed or timed out before finishRun)",
    );

    const fAfter = await db.select().from(sourceRuns).where(eq(sourceRuns.id, fId));
    expect(fAfter).toHaveLength(1);
    const f = fAfter[0]!;
    expect(f.status).toBe("running"); // fresh row swept = the started_at interval window was dropped
    expect(f.finishedAt).toBeNull();
    expect(f.errorSample).toBeNull();
  });

  // RUN-8 — the old-but-terminal row satisfies the age predicate, so only eq(status, 'running')
  // protects it; dropping that clause flips it to 'error' AND makes n === 3 (irreversible audit damage).
  it("only sweeps 'running' rows — an old terminal row keeps its recorded outcome and the swept count is exact", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    // status is plain text (no pgEnum/CHECK), so a terminal row is directly seedable.
    const seeded = await db
      .insert(sourceRuns)
      .values([
        { pipeline: "ingestion", startedAt: twoHoursAgo },
        { pipeline: "ingestion", startedAt: twoHoursAgo },
        { pipeline: "ingestion", startedAt: twoHoursAgo, status: "ok", finishedAt: new Date(), counts: { boards: 1 } },
      ])
      .returning({ id: sourceRuns.id });
    expect(seeded).toHaveLength(3);
    const okId = seeded[2]!.id;

    const n = await failStaleRuns(db);
    expect(n).toBe(2); // n === 3 = the status guard is gone (terminal history swept)

    const okRows = await db.select().from(sourceRuns).where(eq(sourceRuns.id, okId));
    expect(okRows).toHaveLength(1);
    const ok = okRows[0]!;
    expect(ok.status).toBe("ok"); // flipped to 'error' = the sweep destroyed recorded run history
    expect(ok.errorSample).toBeNull();
    expect(ok.counts).toEqual({ boards: 1 });

    for (const runningId of [seeded[0]!.id, seeded[1]!.id]) {
      const rows = await db.select().from(sourceRuns).where(eq(sourceRuns.id, runningId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("error");
      expect(rows[0]!.errorSample).toBe(
        "swept: stale running row (process killed or timed out before finishRun)",
      );
    }
  });

  // RUN-9 — the pre-seeded non-null sample is the discriminator: if the `errorSample: result.errorSample
  // ?? null` set member were deleted, 'pre-set noise' survives. (A NULL-seeded row would be vacuous.)
  it("nulls error_sample when the finish payload omits it — a pre-existing value never survives an ok finish", async () => {
    const seeded = await db
      .insert(sourceRuns)
      .values({ pipeline: "ingestion", errorSample: "pre-set noise" }) // status defaults 'running'
      .returning({ id: sourceRuns.id });
    expect(seeded).toHaveLength(1);
    const id = seeded[0]!.id;

    await finishRun(db, id, { status: "ok", counts: {} }); // errorSample omitted → ?? null

    const rows = await db.select().from(sourceRuns).where(eq(sourceRuns.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("ok");
    expect(rows[0]!.errorSample).toBeNull(); // 'pre-set noise' surviving = errorSample dropped from .set()
  });

  // RUN-10 — complements RUN-5's source='lever': together they pin the pass-through in both
  // directions; the no-opts call form discriminates the `opts = {}` default parameter.
  it("persists a NULL source for the all-sources sweep shape — startRun with no opts argument at all", async () => {
    const id = await startRun(db, "discovery"); // no opts — a removed `= {}` default throws TypeError here

    const rows = await db.select().from(sourceRuns).where(eq(sourceRuns.id, id));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.source).toBeNull();
    expect(row.pipeline).toBe("discovery");
    expect(row.status).toBe("running");
  });
});
