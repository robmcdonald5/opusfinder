// Public surface of @opusfinder/inngest — the typed client + the ONE factory of every served function
// (createAllFunctions; the serve routes register exactly its list). The Node deps wiring (buildDigestDeps
// etc., which read env) lives in ./deps, ./backfill-deps and ./health-deps and is imported directly by the
// serve routes, so this barrel stays the injectable/portable surface. NEVER imported by apps/scrapers
// (guard:worker).
export { inngest } from "./inngest";
export type { DigestEvents } from "./inngest";
export { createAllFunctions } from "./functions";
export type { AllFunctionDeps } from "./functions";
export type { DigestDeps, RerankOutcome } from "./digest";
export type { BackfillDeps } from "./backfill";
export type { HealthCheckDeps } from "./health-check";
