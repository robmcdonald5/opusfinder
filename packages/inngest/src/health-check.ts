/**
 * The health check as an Inngest cron function: a thin adapter over @opusfinder/digest's `runHealthCheck`,
 * which the digest Worker (apps/digest) runs on the same schedule. Kept, paused, until the Worker has run
 * in production; then this package is deleted.
 */
import { HEALTH_CHECK_CRON, runHealthCheck, type HealthCheckDeps } from "@opusfinder/digest";

import { inngest } from "./inngest";

/**
 * health-check-alert — every 2 h (HEALTH_CHECK_CRON). The full check+dedup+send+record runs in ONE
 * `step.run`, so a transient failure (e.g. the send) retries the whole unit. `singleton skip` (keyless ⇒
 * one global flight) drops a tick that fires while the previous run is still in flight.
 */
function makeHealthCheck(deps: HealthCheckDeps) {
  return inngest.createFunction(
    { id: "health-check-alert", singleton: { mode: "skip" } },
    { cron: HEALTH_CHECK_CRON },
    async ({ step }) => step.run("check-and-alert", () => runHealthCheck(deps)),
  );
}

/** The health functions, built with injected deps — concatenated alongside the digest + backfill functions
 *  by `createAllFunctions` (./functions), the list the serve routes register. */
export function createHealthFunctions(deps: HealthCheckDeps) {
  return [makeHealthCheck(deps)];
}
