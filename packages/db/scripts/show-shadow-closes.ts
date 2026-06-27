import { desc, inArray, sql } from "drizzle-orm";

import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";
import { DEFAULT_STALE_TTL_DAYS } from "../src/repos/lifecycle";
import { digests, sourceRuns } from "../src/schema";

/**
 * Read the standing SHADOW close tallies on real traffic BEFORE flipping `LIFECYCLE_CLOSE_ENFORCE` to "enforce". The
 * clean signal is "`wouldClose` is a small, believable staleness trickle", NOT "a large fraction of active
 * jobs": a spike means a transient-incompleteness / empty-fetch bug to fix BEFORE enforce (enabling would
 * then mass-close live jobs), not after.
 *
 * Read-only; echoes only run metadata + integer counters (no titles / PII / secrets). Owner-run against
 * the real DB (the agent can only typecheck it).
 *
 *   pnpm --filter @opusfinder/db shadow-closes [N]      (last N runs + N digests; default 10)
 */
// sweepLifecycle (per board) + closeJobsForCompanies (board death) tally onto source_runs.counts.
// The two close paths name their ENFORCE-closed counter differently: sweepLifecycle → `closed` (ingest.ts),
// closeJobsForCompanies → `jobsClosedOnDeactivation` (discover.ts). Read BOTH so a discovery run's closes
// aren't missed.
const CLOSE_COUNTER_KEYS = [
  "wouldClose",
  "swept",
  "revived",
  "wouldCloseOnDeactivation",
  "closed",
  "jobsClosedOnDeactivation",
] as const;
// probeDigestLiveness (pre-send 410 probe) tallies onto digests.counts.
const PROBE_COUNTER_KEYS = ["probed410WouldClose", "probed410Closed", "probed404Dropped"] as const;
// sweepStaleJobs (its OWN STALE_SWEEP switch) + capped-board observability, both tallied onto an ingestion
// run's source_runs.counts. `staleWouldClose` is the standing population the owner reads BEFORE flipping
// STALE_SWEEP=enforce; `cappedBoards` is how many boards skip the per-board sweep per tick.
const STALE_SWEEP_KEYS = ["cappedBoards", "staleWouldClose", "staleClosed", "staleSweepFailed"] as const;

await runScript("ShowShadowCloses", async () => {
  const limitArg = Number(process.argv[2]);
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.trunc(limitArg) : 10;

  const db = createDb(getDatabaseUrl());

  // Recent ingestion + discovery would-close tallies.
  const runs = await db
    .select({
      id: sourceRuns.id,
      pipeline: sourceRuns.pipeline,
      startedAt: sourceRuns.startedAt,
      counts: sourceRuns.counts,
    })
    .from(sourceRuns)
    .where(inArray(sourceRuns.pipeline, ["ingestion", "discovery"]))
    .orderBy(desc(sourceRuns.startedAt))
    .limit(limit);

  console.log(`=== Arm A/B + Tier-1 stale — last ${runs.length} ingestion/discovery run(s) ===`);
  let wouldCloseTotal = 0;
  let closedTotal = 0;
  let staleWouldCloseTotal = 0;
  let staleClosedTotal = 0;
  for (const r of runs) {
    wouldCloseTotal += num(r.counts, "wouldClose") + num(r.counts, "wouldCloseOnDeactivation");
    closedTotal += num(r.counts, "closed") + num(r.counts, "jobsClosedOnDeactivation");
    staleWouldCloseTotal += num(r.counts, "staleWouldClose");
    staleClosedTotal += num(r.counts, "staleClosed");
    console.log(
      `#${r.id} ${r.pipeline} started=${iso(r.startedAt)} ${pick(r.counts, CLOSE_COUNTER_KEYS)} | ` +
        `${pick(r.counts, STALE_SWEEP_KEYS)}`,
    );
  }
  if (runs.length === 0) console.log("(no ingestion/discovery runs yet)");

  // Recent per-digest 410-probe tallies.
  const digestRows = await db
    .select({ id: digests.id, createdAt: digests.createdAt, counts: digests.counts })
    .from(digests)
    .orderBy(desc(digests.id))
    .limit(limit);

  console.log(`\n=== Arm C — last ${digestRows.length} digest(s) ===`);
  for (const d of digestRows) {
    console.log(`#${d.id} createdAt=${iso(d.createdAt)} ${pick(d.counts, PROBE_COUNTER_KEYS)}`);
  }
  if (digestRows.length === 0) console.log("(no digests yet)");

  // Sanity ceiling — read wouldClose as a fraction of the live corpus.
  const ceilRows = rows(
    await db.execute(sql`
      SELECT count(*) FILTER (WHERE lifecycle_state = 'active')::int AS active,
             count(*) FILTER (WHERE lifecycle_state = 'active' AND consecutive_absences > 0)::int AS pending_streak,
             count(*) FILTER (WHERE lifecycle_state = 'closed')::int AS closed
      FROM jobs`),
  );
  const active = Number(ceilRows[0]?.active ?? 0);
  const pending = Number(ceilRows[0]?.pending_streak ?? 0);
  const closed = Number(ceilRows[0]?.closed ?? 0);

  console.log(`\n=== Corpus ceiling ===`);
  console.log(`jobs: active=${active} pending_streak=${pending} closed=${closed}`);
  const pct = active > 0 ? `${((wouldCloseTotal / active) * 100).toFixed(2)}%` : "n/a";
  console.log(
    `wouldClose across shown runs=${wouldCloseTotal} (${pct} of active); ` +
      `closed across shown runs=${closedTotal}`,
  );
  console.log(
    closedTotal > 0 || closed > 0
      ? "NOTE: closed > 0 — LIFECYCLE_CLOSE_ENFORCE may ALREADY be 'enforce' (shadow never writes 'closed')."
      : "Gate: wouldClose should be a small, believable staleness trickle — NOT a large fraction of active jobs.",
  );

  // Universal staleness timer (sweepStaleJobs) — its OWN STALE_SWEEP switch, read BEFORE flipping it.
  const stalePct = active > 0 ? `${((staleWouldCloseTotal / active) * 100).toFixed(2)}%` : "n/a";
  console.log(
    `\n=== Tier-1 stale timer ===\n` +
      `staleWouldClose across shown runs=${staleWouldCloseTotal} (${stalePct} of active); ` +
      `staleClosed=${staleClosedTotal}`,
  );
  console.log(
    staleClosedTotal > 0
      ? "NOTE: staleClosed > 0 — STALE_SWEEP may ALREADY be 'enforce' (shadow never closes)."
      : "Gate: staleWouldClose is the STANDING stale-active population each tick. The FIRST enforce clears a " +
          "one-time backlog (healthy capped mega-boards' aged-out tails — EXPECTED). Read the per-board breakdown below.",
  );

  // Per-board attribution for the stale timer — the gate's key calibration aid. Replicates sweepStaleJobs'
  // board-health-guarded predicate at the DEFAULT TTL (the deployed STALE_SWEEP_TTL_DAYS may differ). A
  // healthy capped mega-board topping this is EXPECTED (its aged-out tail); the guard
  // (c.last_ingested_at >= cutoff) already excludes any board down > TTL, so a down board's jobs never appear.
  const byBoard = rows(
    await db.execute(sql`
      SELECT c.source, c.slug, count(*)::int AS would_close, max(c.last_ingested_at) AS last_ingested
      FROM jobs j JOIN companies c ON c.id = j.company_id
      WHERE j.lifecycle_state = 'active'
        AND COALESCE(j.last_seen_at, j.created_at) < now() - ${DEFAULT_STALE_TTL_DAYS}::int * interval '1 day'
        AND c.last_ingested_at >= now() - ${DEFAULT_STALE_TTL_DAYS}::int * interval '1 day'
      GROUP BY c.source, c.slug
      ORDER BY would_close DESC
      LIMIT 10`),
  );
  console.log(
    `\n=== Tier-1 stale by board (top ${byBoard.length}, TTL ${DEFAULT_STALE_TTL_DAYS}d, board-health-guarded) ===`,
  );
  for (const b of byBoard) {
    console.log(
      `${String(b.source)}:${String(b.slug)} would_close=${Number(b.would_close)} ` +
        `last_ingested=${iso(b.last_ingested as Date | string | null)}`,
    );
  }
  if (byBoard.length === 0) console.log("(no board-health-eligible stale jobs at this TTL)");
});

/** Read a numeric counter from a RunCounts bag, defaulting a missing/non-numeric key to 0. */
function num(counts: Record<string, number>, key: string): number {
  const v = counts[key];
  return typeof v === "number" ? v : 0;
}

/** `key=value` for each requested counter (missing → 0), space-joined. */
function pick(counts: Record<string, number>, keys: readonly string[]): string {
  return keys.map((k) => `${k}=${num(counts, k)}`).join(" ");
}

/** ISO timestamp for a Date/string column value; `?` for NULL (e.g. an unfinished run). */
function iso(value: Date | string | null): string {
  if (value === null) return "?";
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Normalize a neon-http `db.execute` result to a row array (array, `{rows}`, or scalar). */
function rows(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  if (res && typeof res === "object" && "rows" in res) {
    return (res as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [res as Record<string, unknown>];
}
