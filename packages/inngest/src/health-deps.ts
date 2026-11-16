/**
 * Build the health-check deps for the Node-hosted Inngest function: a neon-http db + env-driven
 * thresholds/modes + the real `sendHealthAlert` + the parsed re-page cooldown. NODE/server-only (reads
 * env). The Resend key is read LAZILY at first send, so the serve process boots without it (an
 * unconfigured alerter fails LOUDLY on its first real page).
 */
import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { healthOptionsFromEnv } from "@opusfinder/db/health";
import { getHealthAlertCooldownH, type HealthCheckDeps } from "@opusfinder/digest";
import { sendHealthAlert } from "@opusfinder/email/node";

export function buildHealthDeps(): HealthCheckDeps {
  return {
    db: createDb(getDatabaseUrl()),
    healthOptions: healthOptionsFromEnv(),
    send: (subject, text) => sendHealthAlert(subject, text),
    cooldownH: getHealthAlertCooldownH(),
  };
}
