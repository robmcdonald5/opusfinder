/**
 * Pure, shape-only render helpers for health alerts — extracted from ./health-alert so the per-check-id
 * metric formatting can be unit-tested in isolation (and reused by the `pnpm health` CLI). Depend ONLY on the
 * HealthCheck type; no I/O, no env, no secrets/PII — counts / ages / ratios only, never job or user text.
 */
import type { HealthCheck } from "@opusfinder/db/health";

/** The `[threshold N]` suffix (empty for boolean checks, whose threshold is null). */
export function thresholdSuffix(check: HealthCheck): string {
  return check.threshold === null ? "" : ` [threshold ${check.threshold}]`;
}

/** Shape-only metric formatting per check id — counts / ages / ratios, never job/user text. */
export function formatMetric(check: HealthCheck): string {
  if (check.metric === null) return "no data";
  switch (check.id) {
    case "ingestion_staleness":
      return `${check.metric.toFixed(1)}h since last ok`;
    case "discovery_window":
      return `${check.metric.toFixed(1)}d since last ok`;
    case "board_fail_ratio":
      return `${(check.metric * 100).toFixed(0)}% boards failed`;
    case "embedding_backlog":
      return `${check.metric} rows`;
    case "digest_health":
      return `${check.metric} errored run(s)`;
    case "bounce_suppression":
      return `${check.metric} affected user(s)`;
    case "discovery_lane_errors":
      return `${check.metric} lane error(s)`;
    default:
      return String(check.metric);
  }
}

/** One shape-only line per check — the alert body line AND the `health_alerts.detail` value (kept identical
 *  so the email and the stored history can't drift). */
export function checkDetail(check: HealthCheck): string {
  return `${check.label} (${check.id}): ${formatMetric(check)}${thresholdSuffix(check)}`;
}
