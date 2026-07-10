/**
 * The shared health-ALERT orchestration: turn a {@link HealthReport} into at most ONE shape-only operator
 * email, deduped so a persistently-firing check pages once per cooldown, not every run. Lives in
 * `@opusfinder/inngest` (which already depends on both `@opusfinder/db` and the Node-only `@opusfinder/email`)
 * so the manual `pnpm health` CLI and the scheduled fn run the SAME logic — they cannot drift on which checks
 * page, how the body reads, or when the cooldown suppresses.
 *
 * The email SEND is injected (`AlertSend`) rather than imported, so this module stays send-agnostic and
 * unit-testable, and the CLI vs scheduled-fn each pass their own `sendHealthAlert`-shaped seam. The DB dedup
 * primitives (`shouldNotify`/`recordHealthAlert`) come from `@opusfinder/db`. Everything echoed is shape-only
 * (no-secrets/PII invariant) — `checkDetail` renders an age/ratio/count, never job or user text.
 */
import type { Db } from "@opusfinder/db";
import {
  DEFAULT_HEALTH_ALERT_COOLDOWN_H,
  recordHealthAlert,
  shouldNotify,
} from "@opusfinder/db/repos";
import { type HealthCheck, type HealthReport, isEnforceFiring } from "@opusfinder/db/health";

import { checkDetail } from "./health-alert-helpers";

export { DEFAULT_HEALTH_ALERT_COOLDOWN_H };

// Re-exported so existing consumers (the `pnpm health` CLI + tests) keep importing the render helpers from
// here; the definitions moved to ./health-alert-helpers for isolated unit testing (case §3-4c).
export { checkDetail, formatMetric, thresholdSuffix } from "./health-alert-helpers";

/** The injected email seam — `sendHealthAlert(subject, text)` from `@opusfinder/email` is assignable. */
export type AlertSend = (subject: string, text: string) => Promise<{ emailId: string }>;

/**
 * Parse `HEALTH_ALERT_COOLDOWN_H` (hours) from env, falling back to the default. Rejects NaN/negatives (an
 * out-of-range value falls through rather than silently disabling/inverting the cooldown). Kept here (Node,
 * reads `process.env`) — NOT in the pure `@opusfinder/db/health` core.
 */
export function getHealthAlertCooldownH(
  env: Record<string, string | undefined> = process.env,
): number {
  const rawCooldown = env.HEALTH_ALERT_COOLDOWN_H;
  if (rawCooldown === undefined || rawCooldown.trim() === "") return DEFAULT_HEALTH_ALERT_COOLDOWN_H;
  const cooldownH = Number(rawCooldown);
  return Number.isFinite(cooldownH) && cooldownH >= 0 ? cooldownH : DEFAULT_HEALTH_ALERT_COOLDOWN_H;
}

export interface HealthAlertOutcome {
  /** Every enforce-mode firing check this run (the report's verdict surface). */
  firing: HealthCheck[];
  /** The subset actually paged this run (cooldown clear) — i.e. the rows recorded + the email contents. */
  notified: HealthCheck[];
  /** The subset withheld because they paged within the cooldown window. */
  suppressed: HealthCheck[];
  /** The sent email id, present only when ≥1 check was notified. */
  emailId?: string;
}

/**
 * Filter the report to its enforce-firing checks, gate each on the per-check cooldown, send ONE batched
 * email for those clear to page, and record one `health_alerts` row per paged check. No firing check clear
 * of the cooldown ⇒ no email and no write (idempotent: a healthy or fully-cooled-down report is a no-op).
 *
 * Ordering — `shouldNotify` (read) → `send` (email) → `recordHealthAlert` (write) — is deliberate: the row
 * is the cooldown gate, so writing it only AFTER a successful send means a send failure leaves the cooldown
 * un-armed and the next run RETRIES the page (rather than recording a row that suppresses a page never
 * actually delivered). The cost is that a within-run retry after a successful send may re-send once
 * (`sendHealthAlert` carries no idempotency key by design) — an acceptable duplicate vs a 24h silence;
 * across runs the recorded row is the real dedup.
 */
export async function alertOnHealth(
  db: Db,
  report: HealthReport,
  send: AlertSend,
  cooldownH: number,
): Promise<HealthAlertOutcome> {
  const firing = report.checks.filter(isEnforceFiring);
  const notified: HealthCheck[] = [];
  const suppressed: HealthCheck[] = [];
  for (const check of firing) {
    if (await shouldNotify(db, check.id, cooldownH)) notified.push(check);
    else suppressed.push(check);
  }
  if (notified.length === 0) return { firing, notified, suppressed };

  const subject = `[opusfinder] health alert — ${notified.length} check(s) firing`;
  const body =
    "opusfinder pipeline health — enforce-mode check(s) firing:\n\n" +
    notified.map((check) => `- ${checkDetail(check)}`).join("\n") +
    "\n\nShape-only; run `pnpm health` for the full report." +
    (suppressed.length > 0
      ? `\n(${suppressed.length} further firing check(s) suppressed within the ${cooldownH}h cooldown.)`
      : "");

  const { emailId } = await send(subject, body);
  for (const check of notified) await recordHealthAlert(db, check, checkDetail(check));
  return { firing, notified, suppressed, emailId };
}
