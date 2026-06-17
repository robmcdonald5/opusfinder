import { createDb } from "@opusfinder/db";
// NOTE: importing @opusfinder/db/env runs loadPackageEnv (populates process.env from packages/db/.env)
// as a side effect — this is what makes the HEALTH_* vars resolvable below; @opusfinder/db/health does
// NOT load any .env. Keep this import even if the DB URL is ever plumbed in another way.
import { getDatabaseUrl } from "@opusfinder/db/env";
import { type HealthCheck, checkHealth, healthOptionsFromEnv, isEnforceFiring } from "@opusfinder/db/health";
import { sendHealthAlert } from "@opusfinder/email";
import { runScript } from "@opusfinder/shared/script";

/**
 * Phase F6 health verdict — the verdict layer over the human-dump readers (`pnpm runs` / `delivery`).
 * Runs `checkHealth` (from @opusfinder/db, the pure/serverless-safe core) over live Neon,
 * prints every check (shadow + enforce + ok) and the cost rollup, and — if any ENFORCE-mode check is
 * firing — emails the operator via `sendHealthAlert` and exits non-zero. Shadow firings are printed but
 * never page (`[[shadow-validate-tunable-filters]]`).
 *
 * Lives in @opusfinder/inngest (not @opusfinder/db) because it both READS (db) and SENDS (email): db is
 * the pure-read scripts home, while the send makes this an action CLI like `digest` — and inngest
 * already depends on both packages, so it avoids a db⇄email workspace cycle.
 *
 * Read-only on the DB. Needs DATABASE_URL (packages/db/.env). Thresholds/modes come from HEALTH_* env
 * (see healthOptionsFromEnv). A real alert send additionally needs ALERT_TO + RESEND_API_KEY +
 * EMAIL_FROM (packages/email/.env) — fail-LOUD: if the report is unhealthy and those are unset,
 * sendHealthAlert throws and this script exits non-zero rather than silently dropping the alert.
 * Output is shape-only (counts / ages / ratios) — no job or user text, no secrets.
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

  // Unhealthy: send ONE shape-only alert summarising the firing enforce checks, then exit non-zero.
  // Reuse the report's own predicate so the alert list can never drift from report.unhealthy's verdict.
  const firing = report.checks.filter(isEnforceFiring);
  const subject = `[opusfinder] health alert — ${firing.length} check(s) firing`;
  const body =
    "opusfinder pipeline health — enforce-mode check(s) firing:\n\n" +
    firing.map((c) => `- ${c.label} (${c.id}): ${formatMetric(c)}${thresholdSuffix(c)}`).join("\n") +
    "\n\nShape-only; run `pnpm health` for the full report.";

  console.error(`health UNHEALTHY — ${firing.length} enforce check(s) firing; sending alert to ALERT_TO.`);
  const { emailId } = await sendHealthAlert(subject, body);
  console.log(`alert sent (email ${emailId}).`);
  process.exitCode = 1;
});

/** The `[threshold N]` suffix (empty for boolean checks) — shared by the printed report + the alert
 *  body so the two can't drift. */
function thresholdSuffix(c: HealthCheck): string {
  return c.threshold === null ? "" : ` [threshold ${c.threshold}]`;
}

/** Shape-only metric formatting per check id — counts / ages / ratios, never job/user text. */
function formatMetric(c: HealthCheck): string {
  if (c.metric === null) return "no data";
  switch (c.id) {
    case "ingestion_staleness":
      return `${c.metric.toFixed(1)}h since last ok`;
    case "discovery_window":
      return `${c.metric.toFixed(1)}d since last ok`;
    case "board_fail_ratio":
      return `${(c.metric * 100).toFixed(0)}% boards failed`;
    case "embedding_backlog":
      return `${c.metric} rows`;
    case "digest_health":
      return `${c.metric} errored run(s)`;
    case "bounce_suppression":
      return `${c.metric} affected user(s)`;
    case "discovery_lane_errors":
      return `${c.metric} lane error(s)`;
    default:
      return String(c.metric);
  }
}
