import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { render } from "@test/db/render";
import { stubExecDb } from "@test/db/stub-exec-db";

import { PRUNE_BATCH, PRUNE_WINDOW_DAYS, prunablePredicate, pruneStaleJobs } from "./prune";
import { OPLOG_PRUNE_BATCH, OPLOG_RETENTION_DAYS, pruneOplog } from "./prune-oplog";

// Leaf pure-unit for the two TTL retention prunes (NO DB, NO creds). Merges scripts/test-prune-oplog.ts
// and scripts/test-prune-stale-jobs.ts. Both prunes emit ONLY raw `db.execute(sql`...`)`, so a stubExecDb
// fake captures each drizzle query object and a `respond` callback dispatches on the RENDERED query KIND
// (count / breakdown / size / DELETE) to hand back canned rows. `resultRows()` passes a plain rows array
// through unchanged, so a count returns `[{ n }]`, a breakdown returns the string-count row, and a DELETE
// returns its batch's `{ id }[]` (length = the RETURNING count). The row SEMANTICS (which rows actually
// match the gate) are the owner's live dry-run gate; here we lock the query SHAPE + param binding.

/** render() is typed `(SQL)`; the stub hands `respond`/`calls` the query as `unknown`, so cast at the seam. */
const renderQ = (query: unknown): { sql: string; params: unknown[] } => render(query as SQL);

/** A DELETE batch's RETURNING rows — `resultRows(...).length` is the deleted count for that batch. */
function arrayOf(n: number): Array<{ id: number }> {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
}

describe("pruneOplog — TTL retention for the append-only oplog tables", () => {
  // The retention registry order IS the dry-run report order; `sql.identifier` quotes each name as `"t"`.
  const OPLOG_TABLES = ["source_runs", "health_alerts", "digest_runs"] as const;
  type OplogTable = (typeof OPLOG_TABLES)[number];
  const tableOf = (text: string): OplogTable | undefined =>
    OPLOG_TABLES.find((t) => text.includes(`"${t}"`));

  it("dry run: exactly 3 age-gated counts, no DELETE, only digest_runs FK-safety-gated", async () => {
    const counts: Record<OplogTable, number> = {
      source_runs: 10,
      health_alerts: 5,
      digest_runs: 3,
    };
    const { db, calls } = stubExecDb((q) => {
      const { sql: text } = renderQ(q);
      const table = tableOf(text);
      if (text.includes("count(*)")) return [{ n: table ? counts[table] : 0 }];
      return [];
    });

    const r = await pruneOplog(db);

    // Exactly the 3 per-table counts, and NEVER a DELETE.
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => !renderQ(c).sql.includes("DELETE FROM"))).toBe(true);

    // Every gate is a count that applies the age window and binds the retention param.
    for (const c of calls) {
      const { sql: text, params } = renderQ(c);
      expect(text).toContain("count(*)");
      expect(text).toContain("interval '1 day'");
      expect(params).toContain(OPLOG_RETENTION_DAYS);
    }

    const gateOf = (t: OplogTable) => calls.map((c) => renderQ(c).sql).find((s) => tableOf(s) === t)!;
    const sourceRunsGate = gateOf("source_runs");
    const healthAlertsGate = gateOf("health_alerts");
    const digestRunsGate = gateOf("digest_runs");

    // Per-table timestamp column.
    expect(sourceRunsGate).toContain('"started_at"');
    expect(healthAlertsGate).toContain('"created_at"');

    // ONLY digest_runs carries the NO-ACTION-FK safety clause (a NOT EXISTS over surviving digests); the
    // dependent-free tables must NOT (they prune purely by age).
    expect(digestRunsGate).toContain("NOT EXISTS");
    expect(digestRunsGate).toContain("FROM digests");
    expect(sourceRunsGate.toLowerCase()).not.toContain("not exists");
    expect(healthAlertsGate.toLowerCase()).not.toContain("not exists");

    // Dry run writes nothing; per-table eligible reflects the counts, deleted is 0 everywhere.
    expect(r.applied).toBe(false);
    expect(r.totalDeleted).toBe(0);
    expect(r.perTable).toHaveLength(3);
    expect(r.perTable.every((t) => t.deleted === 0)).toBe(true);
    expect(r.perTable.find((t) => t.table === "source_runs")?.eligible).toBe(10);
    expect(r.perTable.find((t) => t.table === "digest_runs")?.eligible).toBe(3);
  });

  it("--apply: per-table keyset DELETE loop accumulates across batches; eligible=0 issues no DELETE", async () => {
    const counts: Record<OplogTable, number> = {
      source_runs: 4005,
      health_alerts: 0,
      digest_runs: 7,
    };
    // source_runs: two FULL batches then a SHORT one → the loop continues past full batches, ACCUMULATES
    // the RETURNING count (not overwrites), and terminates on the short batch.
    const deleteReturns: Record<OplogTable, Array<Array<{ id: number }>>> = {
      source_runs: [arrayOf(OPLOG_PRUNE_BATCH), arrayOf(OPLOG_PRUNE_BATCH), arrayOf(5)],
      health_alerts: [],
      digest_runs: [arrayOf(7)],
    };
    const deleteIdx: Record<OplogTable, number> = {
      source_runs: 0,
      health_alerts: 0,
      digest_runs: 0,
    };
    const { db, calls } = stubExecDb((q) => {
      const { sql: text } = renderQ(q);
      const table = tableOf(text);
      if (text.includes("count(*)")) return [{ n: table ? counts[table] : 0 }];
      if (text.includes("DELETE FROM")) {
        if (!table) return [];
        const i = deleteIdx[table]++;
        return deleteReturns[table][i] ?? [];
      }
      return [];
    });

    const r = await pruneOplog(db, { apply: true });

    // source_runs runs 3 delete batches; the first is a keyset CTE binding the batch size as the LIMIT.
    const srDeletes = calls.filter(
      (c) => renderQ(c).sql.includes("DELETE FROM") && tableOf(renderQ(c).sql) === "source_runs",
    );
    expect(srDeletes).toHaveLength(3);
    const first = renderQ(srDeletes[0]!);
    expect(first.sql).toContain("WITH batch AS");
    expect(first.sql).toContain("ORDER BY id");
    expect(first.sql).toContain("RETURNING id");
    expect(first.params).toContain(OPLOG_PRUNE_BATCH);
    // The DELETE CTE must RE-APPLY the eligibility predicate (not just wrap a bare id keyset): the inner
    // SELECT re-binds the age window, so a DELETE that dropped the gate would delete un-aged rows.
    expect(first.sql).toContain("interval '1 day'");

    // source_runs accumulates across the three batches; health_alerts (eligible=0) never DELETEs.
    expect(r.perTable.find((t) => t.table === "source_runs")?.deleted).toBe(OPLOG_PRUNE_BATCH * 2 + 5);
    expect(
      calls.some(
        (c) => renderQ(c).sql.includes("DELETE FROM") && tableOf(renderQ(c).sql) === "health_alerts",
      ),
    ).toBe(false);

    // totalDeleted sums across tables: source_runs (4005) + digest_runs (7).
    expect(r.applied).toBe(true);
    expect(r.totalDeleted).toBe(OPLOG_PRUNE_BATCH * 2 + 5 + 7);
  });

  it("--apply with all eligible=0: short-circuits before any destructive work", async () => {
    const counts: Record<OplogTable, number> = {
      source_runs: 0,
      health_alerts: 0,
      digest_runs: 0,
    };
    const { db, calls } = stubExecDb((q) => {
      const { sql: text } = renderQ(q);
      const table = tableOf(text);
      if (text.includes("count(*)")) return [{ n: table ? counts[table] : 0 }];
      return [];
    });

    const r = await pruneOplog(db, { apply: true });

    expect(calls.every((c) => !renderQ(c).sql.includes("DELETE FROM"))).toBe(true);
    expect(r.applied).toBe(true);
    expect(r.totalDeleted).toBe(0);
  });
});

describe("pruneStaleJobs — TTL hard-delete of long-closed, history-unreferenced jobs", () => {
  // A fake Db dispatching on the query KIND: pg_size_pretty probe → a size row; DELETE → the next batch
  // (then [] once exhausted); anything else → the breakdown row (bigint counts as STRINGS, as neon returns).
  function makeStub(opts: {
    breakdownRow: Record<string, string>;
    deleteReturns?: Array<Array<{ id: number }>>;
  }) {
    const deleteReturns = opts.deleteReturns ?? [];
    let deleteCall = 0;
    return stubExecDb((q) => {
      const { sql: text } = renderQ(q);
      if (text.includes("pg_size_pretty")) return [{ db_size: "123 MB" }];
      if (text.includes("DELETE FROM")) return deleteReturns[deleteCall++] ?? [];
      return [opts.breakdownRow];
    });
  }

  it("prunablePredicate is the byte-shared three-part gate binding the window", () => {
    const { sql: text, params } = render(prunablePredicate());
    // 1) never touch an active/retrievable job; 2) closed long enough; 3) referenced by no digest history.
    expect(text).toContain("lifecycle_state = 'closed'");
    expect(text).toContain("interval '1 day'");
    // Clause 2 must gate on closed_at SPECIFICALLY — a mutation to created_at/updated_at still binds the
    // window param + interval yet prunes the wrong rows, so pin the COLUMN, not just the window shape.
    expect(text).toContain("closed_at < now() -");
    expect(text).toContain("id NOT IN (SELECT job_id FROM digest_items)");
    expect(params).toContain(PRUNE_WINDOW_DAYS);
  });

  it("dry run: exactly one breakdown, no DELETE, string counts coerced via Number", async () => {
    const { db, calls } = makeStub({
      breakdownRow: { closed_total: "10", closed_old: "7", prunable: "5" },
    });

    const r = await pruneStaleJobs(db);

    // Exactly the breakdown; NEVER a DELETE.
    expect(calls).toHaveLength(1);
    const { sql: text, params } = renderQ(calls[0]!);
    expect(text).toContain("closed_total");
    expect(text).toContain("closed_old");
    expect(text).toContain("prunable");
    // The breakdown's prunable count MUST use the SAME unreferenced gate as the delete.
    expect(text).toContain("id NOT IN (SELECT job_id FROM digest_items)");
    // closed_total / closed_old are stub-fed (they come back as strings from the fake), so their aggregate
    // FILTER predicates are otherwise UNASSERTED — a mutated FILTER would still return the canned count.
    // Pin each FILTER structurally to its alias: closed_total counts only closed rows; closed_old ADDS the
    // closed_at window (spacing/newlines inside the rendered FILTER are matched with \s+, not hard-coded).
    expect(text).toContain("FILTER (WHERE lifecycle_state = 'closed')");
    expect(text).toMatch(/FILTER \(WHERE lifecycle_state = 'closed'\)\s+AS closed_total/);
    expect(text).toMatch(/AND closed_at < now\(\) - \$\d+ \* interval '1 day'\)\s+AS closed_old/);
    // The breakdown hand-writes the closed_old window SEPARATELY from prunablePredicate(); BOTH must bind
    // PRUNE_WINDOW_DAYS (>=2 occurrences) so a drift in the duplicated closed_old window is caught.
    expect(params.filter((p) => p === PRUNE_WINDOW_DAYS).length).toBeGreaterThanOrEqual(2);
    expect(calls.every((c) => !renderQ(c).sql.includes("DELETE FROM"))).toBe(true);

    // Counts parsed from the STRING breakdown row; nothing written.
    expect(r.applied).toBe(false);
    expect(r.deleted).toBe(0);
    expect(r.closedTotal).toBe(10);
    expect(r.closedOld).toBe(7);
    expect(r.prunable).toBe(5);
  });

  it("--apply with prunable>0: keyset DELETE loop accumulates across batches", async () => {
    const { db, calls } = makeStub({
      breakdownRow: { closed_total: "5000", closed_old: "4005", prunable: "4005" },
      // Two FULL batches then a SHORT one → the loop continues, accumulates, and terminates.
      deleteReturns: [arrayOf(PRUNE_BATCH), arrayOf(PRUNE_BATCH), arrayOf(5)],
    });

    const r = await pruneStaleJobs(db, { apply: true });

    const deletes = calls.filter((c) => renderQ(c).sql.includes("DELETE FROM"));
    expect(deletes).toHaveLength(3);
    const { sql: deleteSql, params: deleteParams } = renderQ(deletes[0]!);
    expect(deleteSql).toContain("WITH batch AS");
    expect(deleteSql).toContain("ORDER BY id");
    expect(deleteSql).toContain("DELETE FROM jobs");
    expect(deleteSql).toContain("RETURNING id");
    expect(deleteParams).toContain(PRUNE_BATCH);
    // The DELETE CTE must RE-APPLY the full prunable gate, not just the id keyset — the inner SELECT still
    // excludes digest-referenced jobs, so a dropped clause 3 would delete rows the breakdown never counted.
    expect(deleteSql).toContain("id NOT IN (SELECT job_id FROM digest_items)");

    expect(r.applied).toBe(true);
    expect(r.deleted).toBe(PRUNE_BATCH * 2 + 5);
  });

  it("--apply with prunable=0: short-circuits before any destructive work", async () => {
    const { db, calls } = makeStub({
      breakdownRow: { closed_total: "4", closed_old: "0", prunable: "0" },
    });

    const r = await pruneStaleJobs(db, { apply: true });

    expect(calls.every((c) => !renderQ(c).sql.includes("DELETE FROM"))).toBe(true);
    expect(r.applied).toBe(true);
    expect(r.deleted).toBe(0);
  });
});
