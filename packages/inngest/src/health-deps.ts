/**
 * Build the production H1b health-check deps: a neon-http db + env-driven thresholds/modes + the real
 * `sendHealthAlert` + the parsed re-page cooldown. NODE/server-only — it reaches `@opusfinder/email`
 * (Resend) and reads env via `process.env` / the `/env` subpath; the serve routes call it. Never reached
 * from a Worker (`guard:worker` keeps `@opusfinder/inngest` out of the scraper bundle). The Resend key is
 * read LAZILY at first send (the `@opusfinder/email` getters throw at call time), so the serve process boots
 * without it — an unconfigured alerter then fails LOUDLY on its first real page. Mirrors `buildBackfillDeps`
 * (./backfill-deps); kept OUT of the package barrel for the same Node-only reason.
 */
import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { healthOptionsFromEnv } from "@opusfinder/db/health";
import { sendHealthAlert } from "@opusfinder/email";

import { getHealthAlertCooldownH } from "./health-alert";
import type { HealthCheckDeps } from "./health-check";

export function buildHealthDeps(): HealthCheckDeps {
  return {
    db: createDb(getDatabaseUrl()),
    healthOptions: healthOptionsFromEnv(),
    send: (subject, text) => sendHealthAlert(subject, text),
    cooldownH: getHealthAlertCooldownH(),
  };
}
