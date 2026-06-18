import { PgDialect } from "drizzle-orm/pg-core";

import { runScript } from "@opusfinder/shared/script";

import type { Db } from "../src/client";
import { OPLOG_PRUNE_BATCH, OPLOG_RETENTION_DAYS, pruneOplog } from "../src/repos/prune-oplog";

/**
 * Stub smoke for the G3g oplog retention prune (`pruneOplog`) — the JS-decidable surface, NO creds, NO
 * Postgres. A content-aware fake Db dispatches on the rendered query KIND (per-table count / per-table
 * delete-batch), and the emitted SQL is rendered with PgDialect so the query shapes are asserted without a
 * live table. The row SEMANTICS (which rows actually match) are the owner's dry-run gate. Here we lock the
 * safety-critical contract:
 *   - each table's gate is age-windowed (`<ts> < now() - 90d`), binding OPLOG_RETENTION_DAYS as a param;
 *   - ONLY digest_runs carries the FK-safety `NOT EXISTS (… digests …)` clause (so a NO-ACTION-FK delete
 *     can never erase referenced history); source_runs / health_alerts do NOT;
 *   - DRY RUN (default) issues ONLY the per-table counts and NEVER a DELETE;
 *   - --apply issues the keyset DELETE loop per eligible table, accumulates the RETURNING count across
 *     batches, and terminates on a short batch;
 *   - a table with eligible=0 issues NO DELETE.
 *
 *   pnpm --filter @opusfinder/db test:prune-oplog
 */
const dialect = new PgDialect();
const TABLES = ["source_runs", "health_alerts", "digest_runs"] as const;
type TableName = (typeof TABLES)[number];

function rendered(query: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]);
}

function tableOf(text: string): TableName | undefined {
  return TABLES.find((t) => text.includes(`"${t}"`));
}

/**
 * A fake Db that records execute() calls and returns a canned result chosen by the query KIND: a count
 * (`count(*)`) → that table's `{ n }`; a DELETE → the next entry of that table's `deleteReturns` (then []
 * once exhausted). No Postgres, no creds.
 */
function stubDb(opts: {
  counts: Partial<Record<TableName, number>>;
  deleteReturns?: Partial<Record<TableName, Array<Array<{ id: number }>>>>;
}): { db: Db; calls: unknown[] } {
  const calls: unknown[] = [];
  const deleteIdx: Partial<Record<TableName, number>> = {};
  const db = {
    execute: async (query: unknown) => {
      calls.push(query);
      const { sql: text } = rendered(query);
      const table = tableOf(text);
      if (text.includes("count(*)")) return [{ n: table ? (opts.counts[table] ?? 0) : 0 }];
      if (text.includes("DELETE FROM")) {
        if (!table) return [];
        const batches = opts.deleteReturns?.[table] ?? [];
        const i = deleteIdx[table] ?? 0;
        deleteIdx[table] = i + 1;
        return batches[i] ?? [];
      }
      return [];
    },
  } as unknown as Db;
  return { db, calls };
}

function arrayOf(n: number): Array<{ id: number }> {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
}

await runScript("test-prune-oplog", async () => {
  // 1) DRY RUN (default): exactly THREE counts (one per table), NEVER a DELETE; each count age-windowed
  //    and binding the retention param; ONLY digest_runs FK-safety-gated.
  {
    const { db, calls } = stubDb({ counts: { source_runs: 10, health_alerts: 5, digest_runs: 3 } });
    const r = await pruneOplog(db);
    assert(calls.length === 3, `dry run must issue exactly the 3 counts, got ${calls.length}`);
    assert(
      calls.every((c) => !rendered(c).sql.includes("DELETE FROM")),
      "dry run must NOT DELETE",
    );
    for (const c of calls) {
      const { sql: text, params } = rendered(c);
      assert(text.includes("count(*)"), "each dry-run query must be a count");
      assert(text.includes("interval '1 day'"), "each gate must apply the age window");
      assert(params.includes(OPLOG_RETENTION_DAYS), "each gate must bind OPLOG_RETENTION_DAYS");
    }
    const countOf = (t: TableName) =>
      calls.map((c) => rendered(c).sql).find((s) => tableOf(s) === t);
    const sr = countOf("source_runs") ?? "";
    const ha = countOf("health_alerts") ?? "";
    const dr = countOf("digest_runs") ?? "";
    assert(sr.includes('"started_at"'), "source_runs gate must use started_at");
    assert(ha.includes('"created_at"'), "health_alerts gate must use created_at");
    assert(
      dr.includes("NOT EXISTS") && dr.includes("FROM digests"),
      "digest_runs gate MUST carry the FK-safety NOT EXISTS (… digests …) clause",
    );
    assert(
      !sr.toLowerCase().includes("not exists") && !ha.toLowerCase().includes("not exists"),
      "source_runs / health_alerts must NOT carry the NOT EXISTS clause (no dependents)",
    );
    assert(!r.applied && r.totalDeleted === 0, "dry run: applied=false, totalDeleted=0");
    assert(
      r.perTable.length === 3 &&
        r.perTable.every((t) => t.deleted === 0) &&
        r.perTable.find((t) => t.table === "source_runs")?.eligible === 10 &&
        r.perTable.find((t) => t.table === "digest_runs")?.eligible === 3,
      `dry run perTable mapping wrong: ${JSON.stringify(r.perTable)}`,
    );
  }

  // 2) --apply: per-table keyset DELETE loop continues past full batches and terminates on a short one;
  //    the deleted count accumulates the RETURNING rows; the DELETE is keyset-shaped and binds the batch.
  {
    const { db, calls } = stubDb({
      counts: { source_runs: 4005, health_alerts: 0, digest_runs: 7 },
      deleteReturns: {
        source_runs: [arrayOf(OPLOG_PRUNE_BATCH), arrayOf(OPLOG_PRUNE_BATCH), arrayOf(5)],
        digest_runs: [arrayOf(7)],
      },
    });
    const r = await pruneOplog(db, { apply: true });
    const srDeletes = calls.filter(
      (c) => rendered(c).sql.includes("DELETE FROM") && tableOf(rendered(c).sql) === "source_runs",
    );
    assert(
      srDeletes.length === 3,
      `source_runs: expected 3 delete batches, got ${srDeletes.length}`,
    );
    const { sql: dtext, params: dparams } = rendered(srDeletes[0]);
    assert(dtext.includes("WITH batch AS"), "delete must be a keyset CTE");
    assert(dtext.includes("ORDER BY id"), "delete batch must be id-ordered (keyset)");
    assert(dtext.includes("RETURNING id"), "delete must RETURNING id to count the batch");
    assert(dparams.includes(OPLOG_PRUNE_BATCH), "delete must bind the batch size as the LIMIT");
    assert(
      r.perTable.find((t) => t.table === "source_runs")?.deleted === OPLOG_PRUNE_BATCH * 2 + 5,
      `source_runs apply must accumulate across batches: ${JSON.stringify(r.perTable)}`,
    );
    // health_alerts had eligible=0 → NO delete issued for it.
    assert(
      !calls.some(
        (c) =>
          rendered(c).sql.includes("DELETE FROM") && tableOf(rendered(c).sql) === "health_alerts",
      ),
      "health_alerts with eligible=0 must NOT DELETE",
    );
    assert(
      r.applied && r.totalDeleted === OPLOG_PRUNE_BATCH * 2 + 5 + 7,
      `apply totalDeleted wrong: ${JSON.stringify(r)}`,
    );
  }

  // 3) --apply, all eligible=0: short-circuits BEFORE any destructive work — counts only, NO DELETE.
  {
    const { db, calls } = stubDb({ counts: { source_runs: 0, health_alerts: 0, digest_runs: 0 } });
    const r = await pruneOplog(db, { apply: true });
    assert(
      calls.every((c) => !rendered(c).sql.includes("DELETE FROM")),
      "apply with all eligible=0 must NOT DELETE",
    );
    assert(r.applied && r.totalDeleted === 0, "apply with all 0: applied=true, totalDeleted=0");
  }

  console.log(
    `test-prune-oplog OK — 3 tables, ${OPLOG_RETENTION_DAYS}d window; only digest_runs FK-safety-gated; ` +
      `dry run counts-only (no DELETE); --apply keyset loop (batch ${OPLOG_PRUNE_BATCH}) accumulates + ` +
      "terminates; eligible=0 short-circuits.",
  );
});

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
