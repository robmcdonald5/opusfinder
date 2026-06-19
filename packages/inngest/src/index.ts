// Public surface of @opusfinder/inngest — the typed client + the digest functions factory. The Node
// deps wiring (buildDigestDeps, reads env) lives in ./deps and is imported directly by the scripts, so
// this barrel stays the injectable/portable surface. NEVER imported by apps/scrapers (guard:worker).
export { inngest } from "./inngest";
export type { DigestEvents } from "./inngest";
export { createDigestFunctions } from "./digest";
export type { DigestDeps, RerankOutcome } from "./digest";
export { createBackfillFunctions } from "./backfill";
export type { BackfillDeps } from "./backfill";
export { createHealthFunctions } from "./health-check";
export type { HealthCheckDeps } from "./health-check";
