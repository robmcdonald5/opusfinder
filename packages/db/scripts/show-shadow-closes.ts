import { desc, inArray, sql } from "drizzle-orm";

import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";
import { digests, sourceRuns } from "../src/schema";

/**
 * G1a pre-flip observation — read the standing F2 SHADOW close tallies on real traffic BEFORE flipping
 * `F2_ENFORCE` to "enforce". The clean signal is "`wouldClose` is a small, believable staleness trickle",
 * NOT "a large fraction of active jobs": a spike means a transient-incompleteness / empty-fetch bug to fix
 * BEFORE enforce (enabling would then mass-close live jobs), not after. This is the
 * shadow-validate-tunable-filters discipline F2 was built around (PHASE_G1_PLAN §2; the same bags surfaced
 * by `pnpm runs` / `pnpm health`, focused on the close counters in one shot).
 *
 * Read-only; echoes only run metadata + integer counters (no titles / PII / secrets). Owner-run against
 * the real DB (the agent can only typecheck it).
 *
 *   pnpm --filter @opusfinder/db shadow-closes [N]      (last N runs + N digests; default 10)
 */
// Arm A (sweepLifecycle, per board) + Arm B (closeJobsForCompanies, board death) tally onto source_runs.counts.
// NB the two arms name their ENFORCE-closed counter differently: Arm A → `closed` (ingest.ts), Arm B →
// `jobsClosedOnDeactivation` (discover.ts). Read BOTH so a post-flip discovery run's Arm B closes aren't missed.
const ARM_AB_KEYS = [
  "wouldClose",
  "swept",
  "revived",
  "wouldCloseOnDeactivation",
  "closed",
  "jobsClosedOnDeactivation",
] as const;
// Arm C (probeDigestLiveness, pre-send 410 probe) tallies onto digests.counts.
const ARM_C_KEYS = ["probed410WouldClose", "probed410Closed", "probed404Dropped"] as const;

await runScript("ShowShadowCloses", async () => {
  const limitArg = Number(process.argv[2]);
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.trunc(limitArg) : 10;

  const db = createDb(getDatabaseUrl());

  // Arm A/B — recent ingestion + discovery would-close tallies.
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

  console.log(`=== Arm A/B — last ${runs.length} ingestion/discovery run(s) ===`);
  let wouldCloseTotal = 0;
  let closedTotal = 0;
  for (const r of runs) {
    wouldCloseTotal += num(r.counts, "wouldClose") + num(r.counts, "wouldCloseOnDeactivation");
    closedTotal += num(r.counts, "closed") + num(r.counts, "jobsClosedOnDeactivation");
    console.log(`#${r.id} ${r.pipeline} started=${iso(r.startedAt)} ${pick(r.counts, ARM_AB_KEYS)}`);
  }
  if (runs.length === 0) console.log("(no ingestion/discovery runs yet)");

  // Arm C — recent per-digest 410-probe tallies.
  const digestRows = await db
    .select({ id: digests.id, createdAt: digests.createdAt, counts: digests.counts })
    .from(digests)
    .orderBy(desc(digests.id))
    .limit(limit);

  console.log(`\n=== Arm C — last ${digestRows.length} digest(s) ===`);
  for (const d of digestRows) {
    console.log(`#${d.id} createdAt=${iso(d.createdAt)} ${pick(d.counts, ARM_C_KEYS)}`);
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
      ? "NOTE: closed > 0 — F2_ENFORCE may ALREADY be 'enforce' (shadow never writes 'closed')."
      : "Gate: wouldClose should be a small, believable staleness trickle — NOT a large fraction of active jobs.",
  );
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
