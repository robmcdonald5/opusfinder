import { PgDialect } from "drizzle-orm/pg-core";

import { runScript } from "@opusfinder/shared/script";

import type { Db } from "../src/client";
import {
  PRUNE_BATCH,
  PRUNE_WINDOW_DAYS,
  pruneStaleJobs,
  prunablePredicate,
} from "../src/repos/prune";

/**
 * Stub smoke for the G2b prune (`pruneStaleJobs`) — the JS-decidable surface, NO creds, NO Postgres. A
 * content-aware fake Db records every `execute()` and returns a canned result per query KIND (breakdown /
 * size / delete-batch), and the emitted SQL is rendered with PgDialect so the query shapes are asserted
 * without a live table. The SQL *semantics* (which rows actually match the gate) are only fully assertable
 * against a real table — that is the owner's dry-run gate (PHASE_G2_PLAN.md §3). Here we lock the
 * safety-critical contract:
 *   - the three-part eligibility gate is present (closed + window + NOT IN digest_items);
 *   - DRY RUN (default) issues ONLY the breakdown and NEVER a DELETE (decision 6);
 *   - --apply issues the keyset DELETE loop, accumulates the RETURNING count across batches, and
 *     terminates on a short batch;
 *   - --apply with prunable=0 short-circuits (no DELETE);
 *   - the window + batch size bind as params.
 *
 *   pnpm --filter @opusfinder/db test:prune
 */
const dialect = new PgDialect();

function rendered(query: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]);
}

/**
 * A fake Db that records execute() calls and returns a canned result chosen by the query KIND: a
 * pg_size_pretty probe → a size row; a DELETE → the next entry of `deleteReturns` (then [] once exhausted);
 * anything else → the breakdown row. No Postgres, no creds.
 */
function stubDb(opts: {
  breakdownRow: Record<string, string>;
  deleteReturns?: Array<Array<{ id: number }>>;
}): { db: Db; calls: unknown[] } {
  const calls: unknown[] = [];
  const deleteReturns = opts.deleteReturns ?? [];
  let deleteCall = 0;
  const db = {
    execute: async (query: unknown) => {
      calls.push(query);
      const { sql: text } = rendered(query);
      if (text.includes("pg_size_pretty")) return [{ db_size: "123 MB" }];
      if (text.includes("DELETE FROM")) return deleteReturns[deleteCall++] ?? [];
      return [opts.breakdownRow];
    },
  } as unknown as Db;
  return { db, calls };
}

function arrayOf(n: number): Array<{ id: number }> {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
}

await runScript("test-prune-stale-jobs", async () => {
  // 0) The prunable predicate is the three-part gate, byte-shared by the count and the delete.
  {
    const { sql: text, params } = rendered(prunablePredicate());
    assert(text.includes("lifecycle_state = 'closed'"), "gate clause 1: must require closed");
    assert(text.includes("interval '1 day'"), "gate clause 2: must apply the staleness window");
    assert(
      text.includes("id NOT IN (SELECT job_id FROM digest_items)"),
      "gate clause 3: must exclude digest_items-referenced rows (FK-safety + repost-dedup history)",
    );
    assert(params.includes(PRUNE_WINDOW_DAYS), "window must bind as a param");
  }

  // 1) DRY RUN (default): exactly ONE execute (the breakdown), NEVER a DELETE; counts parsed; nothing
  //    written; the breakdown carries the closed_total/closed_old/prunable shape + the full gate.
  {
    const { db, calls } = stubDb({
      breakdownRow: { closed_total: "10", closed_old: "7", prunable: "5" },
    });
    const r = await pruneStaleJobs(db);
    assert(
      calls.length === 1,
      `dry run must issue exactly the breakdown, got ${calls.length} calls`,
    );
    const { sql: text, params } = rendered(calls[0]);
    assert(text.includes("closed_total"), "breakdown must compute closed_total");
    assert(text.includes("closed_old"), "breakdown must compute closed_old");
    assert(text.includes("prunable"), "breakdown must compute prunable");
    assert(
      text.includes("id NOT IN (SELECT job_id FROM digest_items)"),
      "breakdown's prunable count must use the SAME unreferenced gate as the delete",
    );
    // The breakdown hand-writes the closed_old window SEPARATELY from prunablePredicate(); both must bind
    // PRUNE_WINDOW_DAYS (≥2 occurrences) so a drift in the duplicated closed_old window — which would
    // mislead the owner's dry-run believability gate — is caught.
    assert(
      params.filter((p) => p === PRUNE_WINDOW_DAYS).length >= 2,
      "breakdown's closed_old window AND the prunable predicate must both bind PRUNE_WINDOW_DAYS (no drift)",
    );
    assert(
      calls.every((c) => !rendered(c).sql.includes("DELETE FROM")),
      "dry run must NOT DELETE",
    );
    assert(!r.applied && r.deleted === 0, "dry run: applied=false, deleted=0");
    assert(
      r.closedTotal === 10 && r.closedOld === 7 && r.prunable === 5,
      `dry run breakdown mapping wrong: ${JSON.stringify(r)}`,
    );
  }

  // 2) --apply, prunable>0: keyset DELETE loop continues past a FULL batch and terminates on a short one;
  //    the deleted count accumulates the RETURNING rows across batches; the DELETE is keyset-shaped and
  //    binds the batch size.
  {
    const { db, calls } = stubDb({
      breakdownRow: { closed_total: "5000", closed_old: "4005", prunable: "4005" },
      // Two FULL batches then a SHORT one → proves the loop continues past multiple full batches, ACCUMULATES
      // the RETURNING count across them (not overwrites), and terminates on the short batch.
      deleteReturns: [arrayOf(PRUNE_BATCH), arrayOf(PRUNE_BATCH), arrayOf(5)],
    });
    const r = await pruneStaleJobs(db, { apply: true });
    const deletes = calls.filter((c) => rendered(c).sql.includes("DELETE FROM"));
    assert(
      deletes.length === 3,
      `expected 3 delete batches (full, full, short), got ${deletes.length}`,
    );
    const { sql: dtext, params: dparams } = rendered(deletes[0]);
    assert(dtext.includes("WITH batch AS"), "delete must be a keyset CTE");
    assert(dtext.includes("ORDER BY id"), "delete batch must be id-ordered (keyset)");
    assert(dtext.includes("DELETE FROM jobs"), "delete must target jobs");
    assert(dtext.includes("RETURNING id"), "delete must RETURNING id to count the batch");
    assert(dparams.includes(PRUNE_BATCH), "delete must bind the batch size as the LIMIT");
    assert(
      r.applied && r.deleted === PRUNE_BATCH * 2 + 5,
      `apply must accumulate the deleted count across batches: ${JSON.stringify(r)}`,
    );
  }

  // 3) --apply, prunable=0: short-circuits BEFORE any destructive work — breakdown only, NO DELETE.
  {
    const { db, calls } = stubDb({
      breakdownRow: { closed_total: "4", closed_old: "0", prunable: "0" },
    });
    const r = await pruneStaleJobs(db, { apply: true });
    assert(
      calls.every((c) => !rendered(c).sql.includes("DELETE FROM")),
      "apply with prunable=0 must NOT DELETE",
    );
    assert(r.applied && r.deleted === 0, "apply with prunable=0: applied=true, deleted=0");
  }

  console.log(
    `test-prune-stale-jobs OK — gate = closed + ${PRUNE_WINDOW_DAYS}d window + NOT IN digest_items; ` +
      `dry run breakdown-only (no DELETE); --apply keyset loop (batch ${PRUNE_BATCH}) accumulates + ` +
      "terminates; prunable=0 short-circuits.",
  );
});

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
