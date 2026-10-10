// Missed-tick detection (S1 "next scheduled run", C6 "a stage that is on but stops running still raises an
// alarm") from what the ledger already holds: a scheduled stage's last recorded start plus its registry
// `expect` period. No cron parsing — `expect.everyMin` is the period the stage's cron fires at (the README
// lists keeping the two in step as a manual sync item).
import type { StageDef, StageMode } from "./registry";

export interface Cadence {
  /** When the next run should start, or null when nothing says. */
  nextDueAt: string | null;
  /** On (not off), scheduled, and no run has started for one period plus its grace. */
  overdue: boolean;
}

const MINUTE_MS = 60_000;

/**
 * @param lastStartedAt the stage's latest recorded run start.
 * @param resumedAt the last time the stage or the master switch was turned back on from off. A stage
 *   resumed after a long pause hasn't missed anything yet: its period counts from whichever came later.
 */
export function cadence(
  expect: StageDef["expect"],
  effective: StageMode,
  lastStartedAt: string | null | undefined,
  resumedAt: string | null | undefined,
  nowMs: number,
): Cadence {
  // A stage with no run on record can't be late yet: it may simply not record runs (an unwired runtime)
  // or not have reached its first tick. An off stage is never late: a pause is not an outage (C6).
  if (!expect || !lastStartedAt || effective === "off") return { nextDueAt: null, overdue: false };
  const last = Date.parse(lastStartedAt);
  if (!Number.isFinite(last)) return { nextDueAt: null, overdue: false };
  const resumed = resumedAt ? Date.parse(resumedAt) : Number.NaN;
  const from = Number.isFinite(resumed) ? Math.max(last, resumed) : last;
  const due = from + expect.everyMin * MINUTE_MS;
  return {
    nextDueAt: new Date(due).toISOString(),
    overdue: nowMs > due + expect.graceMin * MINUTE_MS,
  };
}
