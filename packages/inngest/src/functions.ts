import { createBackfillFunctions, type BackfillDeps } from "./backfill";
import { createDigestFunctions, type DigestDeps } from "./digest";
import { createHealthFunctions, type HealthCheckDeps } from "./health-check";

/** The deps of each function group: `buildDigestDeps()`, `buildBackfillDeps()`, `buildHealthDeps()`. */
export interface AllFunctionDeps {
  digest: DigestDeps;
  backfill: BackfillDeps;
  health: HealthCheckDeps;
}

/**
 * EVERY Inngest function this app serves: the one list both serve routes register (apps/web
 * /api/inngest in production, scripts/serve.ts locally) and the one control-registry.test.ts checks
 * against the control registry. Add a new function group HERE, never at a serve route, so that check
 * sees it.
 */
export function createAllFunctions(deps: AllFunctionDeps) {
  return [
    ...createDigestFunctions(deps.digest),
    ...createBackfillFunctions(deps.backfill),
    ...createHealthFunctions(deps.health),
  ];
}
