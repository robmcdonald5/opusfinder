import { createDb } from "@opusfinder/db";
// NOTE: importing @opusfinder/db/env runs loadPackageEnv (populates process.env from packages/db/.env)
// as a side effect — this is what makes the HEALTH_* vars resolvable below; @opusfinder/db/health does
// NOT load any .env. Keep this import even if the DB URL is ever plumbed in another way.
import { getDatabaseUrl } from "@opusfinder/db/env";
import { checkHealth, healthOptionsFromEnv } from "@opusfinder/db/health";
import { sendHealthAlert } from "@opusfinder/email";
import { runScript } from "@opusfinder/shared/script";

import {
  alertOnHealth,
  formatMetric,
  getHealthAlertCooldownH,
  thresholdSuffix,
} from "../src/health-alert.ts";

/**
 * Phase F6 health verdict — the verdict layer over the human-dump readers (`pnpm runs` / `delivery`).
 * Runs `checkHealth` (from @opusfinder/db, the pure/serverless-safe core) over live Neon, prints every
 * check (shadow + enforce + ok) and the cost rollup, and — if any ENFORCE-mode check is firing — pages the
 * operator via the SHARED `alertOnHealth` path (H1b). Shadow firings are printed but never page
 * (`[[shadow-validate-tunable-filters]]`).
 *
 * H1b: the alert send is the SAME deduped path the scheduled Inngest fn uses (`../src/health-alert`), so the
 * manual and scheduled runs page-once-per-`HEALTH_ALERT_COOLDOWN_H` consistently and BOTH populate the
 * `health_alerts` history (the Phase-12 panel reads it). This means `pnpm health` is no longer purely
 * read-only: an enforce-firing check that clears the cooldown WRITES one `health_alerts` row + sends one
 * email. Exit is non-zero whenever the report is unhealthy, even if the email was cooldown-suppressed.
 *
 * Lives in @opusfinder/inngest (not @opusfinder/db) because it both READS (db) and SENDS (email). Needs
 * DATABASE_URL (packages/db/.env); thresholds/modes come from HEALTH_* env (see healthOptionsFromEnv), the
 * cooldown from HEALTH_ALERT_COOLDOWN_H. A real alert send additionally needs ALERT_TO + RESEND_API_KEY +
 * EMAIL_FROM (packages/email/.env) — fail-LOUD: if a page is due and those are unset, sendHealthAlert throws
 * and this script exits non-zero rather than silently dropping the alert. Output is shape-only (counts /
 * ages / ratios) — no job or user text, no secrets.
 *
 *   pnpm health
 */
await runScript("ShowHealth", async () => {
  const db = createDb(getDatabaseUrl());
  const report = await checkHealth(db, healthOptionsFromEnv());

  for (const c of report.checks) {
    const flag =
      c.state === "firing" ? (c.mode === "enforce" ? "FIRING (enforce)" : "firing (shadow)") : c.state;
    console.log(`  ${c.label}: ${flag} — ${formatMetric(c)}${thresholdSuffix(c)}  (${c.mode})`);
  }

  const { cost } = report;
  const hit = cost.rerankCacheHitRate === null ? "n/a" : `${(cost.rerankCacheHitRate * 100).toFixed(1)}%`;
  console.log(
    `  Cost (last ${cost.digestsConsidered} digests): rerank cache-hit-rate ${hit} ` +
      `(read ${cost.rerankCacheReadTokens} / creation ${cost.rerankCacheCreationTokens} tokens)`,
  );

  if (!report.unhealthy) {
    console.log("health OK — no enforce-mode check is firing.");
    return;
  }

  // Unhealthy: page via the shared deduped path (cooldown gate + one row per paged check), then exit
  // non-zero. A page suppressed by the cooldown is NOT a failure to alert — the report is simply still
  // unhealthy and was already paged within the window.
  const cooldownH = getHealthAlertCooldownH();
  const outcome = await alertOnHealth(db, report, sendHealthAlert, cooldownH);
  if (outcome.emailId) {
    console.log(
      `alert sent (email ${outcome.emailId}) for ${outcome.notified.length} check(s); ` +
        `${outcome.suppressed.length} suppressed within the ${cooldownH}h cooldown.`,
    );
  } else {
    console.log(
      `health UNHEALTHY — all ${outcome.firing.length} firing check(s) already paged within the ` +
        `${cooldownH}h cooldown; no repeat alert sent.`,
    );
  }
  process.exitCode = 1;
});
