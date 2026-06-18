/**
 * Phase G3g — TTL retention for the append-only OPERATIONAL-LOG tables (PHASE_G3_PLAN.md §8). Besides
 * `jobs` (the balloon G2/G3 bound), three tables grow unboundedly one row per event: `source_runs`
 * (ingestion/discovery runs), `health_alerts` (enforce-firings), and `digest_runs` (digest dispatches).
 * Each row is tiny and slow-growing, but unbounded; this keyset-DELETEs rows past a retention window.
 *
 * Sibling of prune.ts (the jobs prune) — same neon-http SQL, same dry-run-first + keyset-loop discipline,
 * same Worker-safe-but-not-Worker-imported posture (only the Node `prune-oplog.ts` script + its smoke use
 * it). Logs counts only (no row content). Reclaim (VACUUM) is out of band, but these tables are small, so
 * the win is bounding the row COUNT, not disk — autovacuum keeps the pages reusable.
 *
 * `digest_runs` is FK-SAFE-GATED: `digests.digest_run_id` is ON DELETE NO ACTION (G3d, decision 6), so
 * deleting a run a surviving digest still references would FK-VIOLATE — its gate carries a matching
 * `NOT EXISTS (… digests …)` clause. It is therefore mostly INERT BY DESIGN (a dispatched run is pinned
 * by its kept digests, and digests are permanent history): it only reclaims childless/errored runs older
 * than the window. `source_runs`/`health_alerts` have no dependents and prune purely by age.
 */
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "../client";
import { resultRows } from "./sql";

/** Rows older than this (by the table's timestamp column) are eligible (fork G3-OPLOG-RETENTION). One-line
 *  tunable; 90 is well past any operational replay/diagnostic need. */
export const OPLOG_RETENTION_DAYS = 90;

/** id-keyset batch size for the DELETE loop — the prune.ts / reclaim-raw.ts precedent. */
export const OPLOG_PRUNE_BATCH = 2000;

/** One oplog table's retention spec. `fkSafeAgainstDigests` adds the NO-ACTION-FK safety clause that
 *  keeps a `digest_runs` delete from violating `digests.digest_run_id` (and erasing referenced history). */
interface OplogSpec {
  name: string;
  ts: string;
  fkSafeAgainstDigests?: boolean;
}

/** The retention registry. Order is the dry-run report order. */
const OPLOG_TABLES: OplogSpec[] = [
  { name: "source_runs", ts: "started_at" },
  { name: "health_alerts", ts: "created_at" },
  { name: "digest_runs", ts: "started_at", fkSafeAgainstDigests: true },
];

/**
 * The eligibility predicate for one oplog table — built FRESH per call (the prunablePredicate parity
 * discipline) so the dry-run count and the DELETE filter on a byte-identical condition. A row is eligible
 * IFF it is older than the window AND (for `digest_runs`) referenced by NO surviving digest. The
 * `${n} * interval '1 day'` form binds the window as a param (retrieval.ts / prune.ts idiom);
 * `sql.identifier` quotes the in-code table/column names (never input).
 */
function oldPredicate(spec: OplogSpec): SQL {
  const ts = sql.identifier(spec.ts);
  const base = sql`${ts} < now() - ${OPLOG_RETENTION_DAYS} * interval '1 day'`;
  if (!spec.fkSafeAgainstDigests) return base;
  const tbl = sql.identifier(spec.name);
  return sql`${base} AND NOT EXISTS (SELECT 1 FROM digests d WHERE d.digest_run_id = ${tbl}.id)`;
}

/** Per-table outcome (returned for the script log + the smoke's assertions). */
export interface OplogTableResult {
  table: string;
  /** Rows matching the retention gate (old + — for digest_runs — unreferenced). */
  eligible: number;
  /** Rows actually DELETEd this run (0 on a dry run). */
  deleted: number;
}

export interface OplogPruneResult {
  perTable: OplogTableResult[];
  applied: boolean;
  totalDeleted: number;
}

/**
 * Run the oplog retention prune. Default (`apply: false`) is a DRY RUN: it counts + logs the eligible rows
 * per table and writes NOTHING (eyeball the counts first — the §8 dry-run gate). With `apply: true` it
 * id-keyset-DELETEs each table's eligible rows in OPLOG_PRUNE_BATCH chunks until a short batch (a deleted
 * row no longer matches, so it always terminates). Counts only in the logs — never row content.
 */
export async function pruneOplog(
  db: Db,
  opts: { apply?: boolean } = {},
): Promise<OplogPruneResult> {
  const apply = opts.apply ?? false;
  const perTable: OplogTableResult[] = [];
  let totalDeleted = 0;

  for (const spec of OPLOG_TABLES) {
    const tbl = sql.identifier(spec.name);
    const cnt = await db.execute(
      sql`SELECT count(*)::int AS n FROM ${tbl} WHERE ${oldPredicate(spec)}`,
    );
    const eligible = Number((resultRows(cnt)[0] as { n?: number } | undefined)?.n ?? 0);
    console.log(
      `${spec.name}: ${eligible} row(s) older than ${OPLOG_RETENTION_DAYS}d` +
        (spec.fkSafeAgainstDigests ? " and unreferenced by any digest" : ""),
    );

    let deleted = 0;
    if (apply && eligible > 0) {
      for (;;) {
        const res = await db.execute(sql`
          WITH batch AS (
            SELECT id FROM ${tbl} WHERE ${oldPredicate(spec)} ORDER BY id LIMIT ${OPLOG_PRUNE_BATCH}
          )
          DELETE FROM ${tbl} WHERE id IN (SELECT id FROM batch) RETURNING id`);
        const n = resultRows(res).length;
        deleted += n;
        if (n > 0) console.log(`  ${spec.name}: deleted ${deleted} ...`);
        if (n < OPLOG_PRUNE_BATCH) break;
      }
    }
    totalDeleted += deleted;
    perTable.push({ table: spec.name, eligible, deleted });
  }

  if (!apply) {
    console.log("DRY RUN — nothing deleted. Re-run with `--apply` to delete the eligible rows.");
  } else {
    console.log(
      `done — deleted ${totalDeleted} oplog row(s) total. Reclaim is out of band (autovacuum keeps the ` +
        "pages reusable; these tables are small, so a manual VACUUM is rarely worth it).",
    );
  }
  return { perTable, applied: apply, totalDeleted };
}
