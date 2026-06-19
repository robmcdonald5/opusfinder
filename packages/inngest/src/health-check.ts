/**
 * Phase H1b — the scheduled, UNATTENDED content health checker, as an Inngest cron function. F6 built
 * `checkHealth` (pure, serverless-safe) + `sendHealthAlert` but left them MANUAL (`pnpm health`) and
 * shadow-only. This runs the SAME checker on a schedule, dedups via `health_alerts`, and emails the
 * operator a NAMED-subsystem alert ("Ingestion staleness: 4.2h since last ok") — the rich complement to
 * the Worker's content-free liveness watchdog. The 2026-06-19 outage motivated it: "DOWN" with no cause.
 *
 * Runs on the same Phase-12 12a runtime (Inngest Cloud + Vercel) as the digest cadence cron and the F8
 * embed-backlog drain — served from `apps/web/api/inngest`, durable retry + observability for free. NEVER
 * reaches the scraper Worker (`@opusfinder/inngest` is on `guard:worker`'s deny list, and this pulls in the
 * Node-only email send via injected deps). Mirrors `createBackfillFunctions` (./backfill).
 */
import type { Db } from "@opusfinder/db";
import { checkHealth, type HealthOptions } from "@opusfinder/db/health";

import { alertOnHealth, type AlertSend } from "./health-alert";
import { inngest } from "./inngest";

/** Injected seams — wired by `buildHealthDeps()` (./health-deps). Mirrors `BackfillDeps`/`DigestDeps`. */
export interface HealthCheckDeps {
  db: Db;
  /** Thresholds + per-check `off|shadow|enforce` modes (from `healthOptionsFromEnv` in the deps builder). */
  healthOptions: HealthOptions;
  /** The operator email seam — `sendHealthAlert` from `@opusfinder/email`. */
  send: AlertSend;
  /** Re-page cooldown (hours) — `HEALTH_ALERT_COOLDOWN_H`, parsed in the deps builder. */
  cooldownH: number;
}

/**
 * health-check-alert — every 30 min, recompute the verdict and page the operator for any ENFORCE-mode
 * firing check not already paged inside the cooldown. The full check+dedup+send+record runs in ONE
 * `step.run`, so a transient failure (e.g. the send) retries the whole unit — NOT transactionally: a retry
 * after a successful send may re-page once (see `alertOnHealth`'s read→send→record note), so the cooldown
 * ROW is the cross-run dedup, not within-run atomicity. A healthy/cooled-down report is a no-op.
 * `singleton skip` (keyless ⇒ one global flight) drops a tick that fires while the previous run is still in
 * flight — never relevant at this cadence, but free insurance and consistent with the F8 drain.
 */
function makeHealthCheck(deps: HealthCheckDeps) {
  return inngest.createFunction(
    { id: "health-check-alert", singleton: { mode: "skip" } },
    { cron: "*/30 * * * *" }, // every 30 min — sensitive layer; the watchdog grace (H1c) is the dumb canary
    async ({ step }) =>
      step.run("check-and-alert", async () => {
        const report = await checkHealth(deps.db, deps.healthOptions);
        const outcome = await alertOnHealth(deps.db, report, deps.send, deps.cooldownH);
        // Shape-only, JSON-safe — surfaces in the Inngest run output for at-a-glance observability.
        return {
          unhealthy: report.unhealthy,
          firing: outcome.firing.map((c) => c.id),
          notified: outcome.notified.map((c) => c.id),
          suppressed: outcome.suppressed.map((c) => c.id),
          emailId: outcome.emailId ?? null,
        };
      }),
  );
}

/** The H1b health functions, built with injected deps — concatenated alongside the digest + backfill
 *  functions in the serve routes. Mirrors `createBackfillFunctions`. */
export function createHealthFunctions(deps: HealthCheckDeps) {
  return [makeHealthCheck(deps)];
}
