import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { render } from "@test/db/render";
import { stubExecDb } from "@test/db/stub-exec-db";

import {
  ABSENCE_CLOSE_THRESHOLD,
  closeJobsForCompanies,
  DEFAULT_STALE_TTL_DAYS,
  markCompanyIngested,
  markJobsPresent,
  sweepLifecycle,
  sweepStaleJobs,
} from "./lifecycle";

// Leaf unit for the lifecycle-close writers — the JS-decidable surface only, NO Postgres, NO creds.
// Ports scripts/test-lifecycle-sweep.ts: a fake Db (stubExecDb) records every db.execute() call and
// returns a canned aggregate row (bigint counts as STRINGS, exactly as neon-http returns them); the
// emitted drizzle `sql` is rendered via PgDialect (render) so the branch shape / param binding is
// asserted without a live table. The SQL *semantics* (the increment / close / revive transitions) are
// the PGlite/live gate's job — here we lock the safety-critical JS logic (empty-set no-ops, the
// shadow-suppresses-close-write structural gate, the closed_at-in-lockstep invariant, NUL stripping,
// threshold/TTL binding, bigint-string → number mapping).

// U+0000 built at runtime — this source file never contains an actual NUL byte.
const NUL = String.fromCharCode(0);

// The canned sweepLifecycle aggregate; production reads revived/closed/would_close/swept off row[0].
const OK_ROW = [{ revived: "0", closed: "0", would_close: "0", swept: "0" }];

/** Render the first captured db.execute() query (calls[0]) to `{ sql, params }`. */
function firstQuery(calls: unknown[]): { sql: string; params: unknown[] } {
  return render(calls[0] as SQL);
}

describe("sweepLifecycle — per-board feed-absence sweep (shadow suppresses close; enforce writes it)", () => {
  it("empty present set is a HARD no-op — never touches the DB and returns all zeros", async () => {
    const { db, calls } = stubExecDb(() => OK_ROW);
    const r = await sweepLifecycle(db, 1, []);
    expect(calls.length).toBe(0); // `<> ALL('{}')` would close the whole board — must not run
    expect(r).toEqual({ revived: 0, swept: 0, closed: 0, wouldClose: 0 });
  });

  it("shadow (default) suppresses the close write, unnests the jsonb param, increments the streak SQL-side, and binds companyId + default threshold", async () => {
    const { db, calls } = stubExecDb(() => OK_ROW);
    await sweepLifecycle(db, 7, ["a", "b"]);
    const { sql, params } = firstQuery(calls);

    expect(sql).not.toContain("THEN 'closed'"); // count-only must NOT emit a close write
    expect(sql).toContain("jsonb_array_elements_text"); // present set unnested from a jsonb param
    expect(sql).toContain("consecutive_absences + 1"); // streak increments SQL-side (no read-modify-write)
    // In shadow (no close branch) the streak caps at the threshold, else an ever-absent row overflows smallint.
    expect(sql).toContain("LEAST(jobs.consecutive_absences + 1");
    // closed_at clock: the revive-clear (present → NULL) is emitted in shadow too, but no close-stamp.
    expect(sql).toContain("closed_at = CASE");
    expect(sql).toContain("THEN NULL");
    expect(sql).not.toContain("THEN now()"); // no close → no closed_at stamp in shadow
    expect(params).toContain(7); // companyId bound
    expect(params).toContain(ABSENCE_CLOSE_THRESHOLD); // default threshold (3) bound
  });

  it("enforce emits the 'closed' write AND the closed_at stamp, each guarded by the SAME +1>=threshold predicate (lockstep)", async () => {
    const { db, calls } = stubExecDb(() => OK_ROW);
    await sweepLifecycle(db, 7, ["a"], { enforce: true });
    const { sql } = firstQuery(calls);

    expect(sql).toContain("THEN 'closed'");
    expect(sql).toContain("THEN NULL"); // enforce still clears closed_at on revive
    // LOCKSTEP: both the 'closed' write and the closed_at stamp ride the same guard, so closed_at is
    // non-NULL iff the row is in a closed episode (the invariant the irreversible prune keys on).
    expect(sql).toMatch(/consecutive_absences \+ 1 >= \$\d+ THEN 'closed'/);
    expect(sql).toMatch(/consecutive_absences \+ 1 >= \$\d+ THEN now\(\)/);
    expect((sql.match(/consecutive_absences \+ 1 >= /g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("maps the bigint-as-string aggregate row to SweepResult numbers", async () => {
    const { db } = stubExecDb(() => [{ revived: "2", closed: "1", would_close: "4", swept: "3" }]);
    const r = await sweepLifecycle(db, 7, ["a"], { enforce: true });
    expect(r).toEqual({ revived: 2, swept: 3, closed: 1, wouldClose: 4 });
  });

  it("strips NUL from external_ids before the jsonb param (jsonb rejects a NUL byte)", async () => {
    const { db, calls } = stubExecDb(() => OK_ROW);
    await sweepLifecycle(db, 7, [`job${NUL}1`, "clean2"]);
    const { params } = firstQuery(calls);

    const jsonParam = params.find((p) => typeof p === "string" && p.includes("job")) as
      | string
      | undefined;
    expect(jsonParam).toBeDefined();
    expect(jsonParam!).not.toContain(NUL);
    expect(JSON.parse(jsonParam!) as string[]).toContain("job1");
  });

  it("binds a custom threshold (5)", async () => {
    const { db, calls } = stubExecDb(() => OK_ROW);
    await sweepLifecycle(db, 7, ["a"], { threshold: 5 });
    expect(firstQuery(calls).params).toContain(5);
  });
});

describe("closeJobsForCompanies — board-death bulk close by company_id", () => {
  it("empty ids is an early-out — never hits the DB and returns zeros", async () => {
    const { db, calls } = stubExecDb(() => [{ would_close: "9" }]);
    const r = await closeJobsForCompanies(db, []);
    expect(calls.length).toBe(0);
    expect(r).toEqual({ closed: 0, wouldClose: 0 });
  });

  it("shadow (default) counts would-close via count(*), binds ids as an ::int[] literal, and writes nothing", async () => {
    const { db, calls } = stubExecDb(() => [{ would_close: "5" }]);
    const r = await closeJobsForCompanies(db, [10, 20]);
    const { sql, params } = firstQuery(calls);

    expect(sql).not.toContain("UPDATE"); // shadow must NOT write
    expect(sql).toContain("count(*)");
    expect(sql).toMatch(/count\(\*\)\s+AS would_close/i); // the read row.would_close is bound to this alias
    expect(sql).toContain("::int[]"); // company ids bind as an int[] literal
    // GUARD: count only ACTIVE rows, bound to the id match. Without `AND lifecycle_state = 'active'` the
    // shadow over-counts already-closed rows, corrupting the would-close signal the enforce rollout gates on.
    expect(sql).toMatch(/company_id = ANY\(\$\d+::int\[\]\) AND lifecycle_state = 'active'/i);
    expect(params).toContain("{10,20}");
    expect(r).toEqual({ closed: 0, wouldClose: 5 });
  });

  it("enforce UPDATEs to 'closed', stamps closed_at = now(), and returns the RETURNING row count", async () => {
    const { db, calls } = stubExecDb(() => [{ id: 1 }, { id: 2 }, { id: 3 }]);
    const r = await closeJobsForCompanies(db, [10], { enforce: true });
    const { sql } = firstQuery(calls);

    expect(sql).toContain("UPDATE");
    expect(sql).toContain("'closed'");
    expect(sql).toContain("closed_at = now()");
    // GUARD: the re-close is scoped to ACTIVE rows only. Without `AND lifecycle_state = 'active'` an
    // already-closed row is re-UPDATEd, re-stamping closed_at = now() and resetting the 30-day
    // irreversible-prune clock (churns dead tuples → the DB-bloat/outage class). Lock it to the id match.
    expect(sql).toMatch(/company_id = ANY\(\$\d+::int\[\]\) AND lifecycle_state = 'active'/i);
    // The closed:3 count is the RETURNING row length — bind it to the clause that produces those rows.
    expect(sql).toMatch(/RETURNING\s+id/i);
    expect(r).toEqual({ closed: 3, wouldClose: 0 });
  });
});

describe("sweepStaleJobs — universal staleness closer with the board-health guard", () => {
  it("shadow (default) counts, uses the COALESCE staleness predicate, JOINs companies for the board-health guard, and binds the default TTL", async () => {
    const { db, calls } = stubExecDb(() => [{ would_close: "5" }]);
    const r = await sweepStaleJobs(db);
    const { sql, params } = firstQuery(calls);

    expect(sql).not.toContain("UPDATE"); // shadow must NOT write
    expect(sql).toContain("count(*)");
    expect(sql).toMatch(/count\(\*\)\s+AS would_close/i); // the read row.would_close is bound to this alias
    expect(sql).toContain("COALESCE(jobs.last_seen_at, jobs.created_at)"); // staleness predicate
    expect(sql).toContain("lifecycle_state = 'active'"); // scoped to active jobs
    expect(sql).toMatch(/join\s+"companies"/i); // board-health guard join
    expect(sql).toContain("c.last_ingested_at >="); // requires a recent successful ingest
    expect(params).toContain(DEFAULT_STALE_TTL_DAYS); // default TTL (21) bound
    expect(r).toEqual({ closed: 0, wouldClose: 5 });
  });

  it("enforce UPDATEs to 'closed', stamps closed_at, ALSO applies the board-health guard, and returns the RETURNING row count", async () => {
    const { db, calls } = stubExecDb(() => [{ id: 1 }, { id: 2 }, { id: 3 }]);
    const r = await sweepStaleJobs(db, { enforce: true });
    const { sql } = firstQuery(calls);

    expect(sql).toContain("UPDATE");
    expect(sql).toContain("'closed'");
    expect(sql).toContain("closed_at = now()");
    expect(sql).toContain("c.last_ingested_at >="); // board-health guard still applied under enforce
    // The closed:3 count is the RETURNING row length — bind it to the clause that produces those rows.
    expect(sql).toMatch(/RETURNING\s+jobs\.id/i);
    expect(r).toEqual({ closed: 3, wouldClose: 0 });
  });

  it.each([
    { ttlDays: 30, bound: 30, label: "binds a custom ttlDays (30) verbatim" },
    { ttlDays: 0, bound: 1, label: "floors a non-positive ttlDays (0) to 1" },
  ])("$label", async ({ ttlDays, bound }) => {
    const { db, calls } = stubExecDb(() => [{ would_close: "0" }]);
    await sweepStaleJobs(db, { ttlDays });
    expect(firstQuery(calls).params).toContain(bound);
  });
});

describe("markJobsPresent — positive 'I saw this job live' writer (refresh + revive)", () => {
  it("empty present set is a no-op — never hits the DB and returns revived 0", async () => {
    const { db, calls } = stubExecDb(() => [{ revived: "0" }]);
    const r = await markJobsPresent(db, 1, []);
    expect(calls.length).toBe(0);
    expect(r).toEqual({ revived: 0 });
  });

  it("stamps last_seen_at, revives (active + clear closed_at), and carries the >1h no-op guard", async () => {
    const { db, calls } = stubExecDb(() => [{ revived: "2" }]);
    await markJobsPresent(db, 7, ["a", "b"]);
    const { sql } = firstQuery(calls);

    expect(sql).toContain("last_seen_at = now()");
    expect(sql).toContain("lifecycle_state = 'active'");
    expect(sql).toContain("closed_at = NULL");
    // NO-OP GUARD: touch only rows stale >1h or needing revival — an unchanged board doesn't churn.
    expect(sql).toContain("last_seen_at < now() - interval '1 hour'");
  });

  it("counts revivals from the pre-update revived_set snapshot, unnests the jsonb param, and binds companyId", async () => {
    const { db, calls } = stubExecDb(() => [{ revived: "2" }]);
    await markJobsPresent(db, 7, ["a", "b"]);
    const { sql, params } = firstQuery(calls);

    expect(sql).toContain("revived_set"); // count from the statement-start closed snapshot
    expect(sql).toContain("jsonb_array_elements_text"); // present set unnested from a jsonb param
    expect(params).toContain(7); // companyId bound
    // companyId is bound TWICE (the revived_set snapshot AND the upd UPDATE), so params.toContain(7) stays
    // green even if the UPDATE lost its OWN `jobs.company_id` scope — which would revive/refresh EVERY
    // company's jobs whose external_id collides (cross-company revival of closed postings). Lock BOTH:
    // (1) the UPDATE carries a company scope of its own, and (2) both CTEs are scoped (>= 2 occurrences).
    expect(sql).toMatch(/UPDATE\s+"jobs"[\s\S]*?WHERE\s+jobs\.company_id = \$\d+/i);
    expect((sql.match(/jobs\.company_id = \$\d+/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("strips NUL from the present set", async () => {
    const { db, calls } = stubExecDb(() => [{ revived: "2" }]);
    await markJobsPresent(db, 7, [`job${NUL}1`, "clean2"]);
    const { params } = firstQuery(calls);

    const jsonParam = params.find((p) => typeof p === "string" && p.includes("job")) as
      | string
      | undefined;
    expect(jsonParam).toBeDefined();
    expect(jsonParam!).not.toContain(NUL);
    expect(JSON.parse(jsonParam!) as string[]).toContain("job1");
  });

  it("maps the revived bigint-as-string count to a number", async () => {
    const { db } = stubExecDb(() => [{ revived: "2" }]);
    const r = await markJobsPresent(db, 7, ["a"]);
    expect(r).toEqual({ revived: 2 });
  });
});

describe("markCompanyIngested — certify a successful non-empty board fetch", () => {
  it("stamps companies.last_ingested_at = now() and binds the companyId", async () => {
    const { db, calls } = stubExecDb(() => []);
    await markCompanyIngested(db, 42);
    const { sql, params } = firstQuery(calls);

    expect(sql).toMatch(/update\s+"companies"\s+set\s+last_ingested_at\s*=\s*now\(\)/i);
    expect(params).toContain(42);
  });
});
