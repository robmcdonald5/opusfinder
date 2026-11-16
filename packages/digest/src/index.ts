// Public surface of @opusfinder/digest: the digest's stage code (the orchestrator and the per-user run,
// written against injected step tools), its production deps, and the health check. Engine-free and
// Worker-safe: nothing here imports a workflow engine, a Node builtin or an env loader. apps/digest runs
// the stages on Cloudflare Workflows.
export {
  DIGEST_CADENCE_CRON,
  runOrchestrator,
  runPerUser,
  UUID_PATTERN,
  type DigestDeps,
  type OrchestratorEvent,
  type OrchestratorStepTools,
  type PerUserEvent,
  type PerUserStepTools,
  type RerankOutcome,
  type UserRequestedEvent,
} from "./digest";
export { buildDigestDeps, type DigestConfig } from "./deps";
export { NonRetriableError } from "./errors";
export {
  HEALTH_CHECK_CRON,
  runHealthCheck,
  type HealthCheckDeps,
  type HealthCheckResult,
} from "./health-check";
export { alertOnHealth, getHealthAlertCooldownH, type AlertSend } from "./health-alert";
export { formatMetric, thresholdSuffix } from "./health-alert-helpers";
