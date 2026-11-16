/**
 * The scheduled, UNATTENDED content health check: run `checkHealth`, dedup via `health_alerts`, and email
 * the operator a NAMED-subsystem alert ("Ingestion staleness: 4.2h since last ok") — the rich complement to
 * the scrapers Worker's content-free liveness watchdog. The 2026-06-19 outage motivated it: "DOWN" with no
 * cause. The digest Worker (apps/digest) runs it on HEALTH_CHECK_CRON; `pnpm health` runs the same check
 * by hand.
 */
import type { Db } from "@opusfinder/db";
import { checkHealth, type HealthOptions } from "@opusfinder/db/health";

import { alertOnHealth, type AlertSend } from "./health-alert";

/** Injected seams. Mirrors `DigestDeps`. */
export interface HealthCheckDeps {
  db: Db;
  /** Thresholds + per-check `off|shadow|enforce` modes (from `healthOptionsFromEnv`). */
  healthOptions: HealthOptions;
  /** The operator email seam — `sendHealthAlert` from `@opusfinder/email`. */
  send: AlertSend;
  /** Re-page cooldown (hours) — `HEALTH_ALERT_COOLDOWN_H`. */
  cooldownH: number;
}

/**
 * The cron: every 2 h at :10 — 10 min after each ingestion tick starts (`0 *\/2 * * *`, the scrapers
 * Worker), so its Neon reads land while the tick has Neon awake. A check on its own schedule (it was every
 * 30 min) woke Neon by itself, each wake billing a fixed 5-min autosuspend tail. 2 h is ample for a
 * monitor whose ingestion staleness threshold is 5 h and whose re-page cooldown is 24 h. Its latest-run
 * checks read the latest FINISHED ingestion run, so a tick still in flight at :10 isn't misread.
 */
export const HEALTH_CHECK_CRON = "10 */2 * * *";

/** What one check reports: shape-only and JSON-safe (check ids and an email id, never job or user text). */
export interface HealthCheckResult {
  unhealthy: boolean;
  /** Checks firing in any mode: an enforce-mode one pages, a shadow-mode one is only reported here. */
  firingShadow: string[];
  firing: string[];
  notified: string[];
  suppressed: string[];
  emailId: string | null;
}

/**
 * Recompute the verdict and page the operator for any ENFORCE-mode firing check not already paged inside
 * the cooldown. NOT transactional: a retry after a successful send may re-page once, so the cooldown ROW is
 * the cross-run dedup, not within-run atomicity. A healthy or cooled-down report sends and writes nothing.
 */
export async function runHealthCheck(deps: HealthCheckDeps): Promise<HealthCheckResult> {
  const report = await checkHealth(deps.db, deps.healthOptions);
  const outcome = await alertOnHealth(deps.db, report, deps.send, deps.cooldownH);
  return {
    unhealthy: report.unhealthy,
    firingShadow: report.checks
      .filter((c) => c.state === "firing" && c.mode === "shadow")
      .map((c) => c.id),
    firing: outcome.firing.map((c) => c.id),
    notified: outcome.notified.map((c) => c.id),
    suppressed: outcome.suppressed.map((c) => c.id),
    emailId: outcome.emailId ?? null,
  };
}
