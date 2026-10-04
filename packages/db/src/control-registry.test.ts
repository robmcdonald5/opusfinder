import { describe, expect, expectTypeOf, it } from "vitest";

import { POLICY_IDS, policyDef, type PolicyId } from "@opusfinder/control";

import {
  DEFAULT_HEALTH_THRESHOLDS,
  evaluateHealth,
  healthOptionsFromEnv,
  type HealthCheckId,
  type HealthSignals,
  type HealthThresholds,
} from "./health";

// The control-plane registry (@opusfinder/control) declares one `health.<id>` policy per health check, but
// it is a pure leaf and may not import this module (db/health reads `process` — the H1 landmine). So the
// sync check lives HERE, in the source of truth, pointing at the registry: a check added to health.ts
// without its registry entry (or vice versa) fails, as does a threshold default or env name that drifts.

type RegistryHealthId = PolicyId extends infer P
  ? P extends `health.${infer Id}`
    ? Id
    : never
  : never;

const QUIET: HealthSignals = {
  ingestionAgeH: 0,
  latestIngestStatus: "ok",
  latestIngestFailed: 0,
  latestIngestProcessed: 10,
  latestIngestCompanies: 10,
  discoveryAgeD: 0,
  discoveryLaneErrors: 0,
  embeddingBacklog: 0,
  digestErrors: 0,
  hardBounces: 0,
  suppressed: 0,
  cost: { digestsConsidered: 0, rerankCacheReadTokens: 0, rerankCacheCreationTokens: 0 },
};

/** Which HealthThresholds field each registry threshold knob stands for. */
const THRESHOLD_FIELD: Partial<Record<HealthCheckId, keyof HealthThresholds>> = {
  ingestion_staleness: "ingestMaxAgeH",
  board_fail_ratio: "failRatio",
  discovery_window: "discoveryMaxAgeD",
  embedding_backlog: "backlogMax",
};

describe("control registry ⇄ db/health", () => {
  it("declares exactly one health.<id> policy per HealthCheckId (type level, enforced by typecheck:test)", () => {
    expectTypeOf<RegistryHealthId>().toEqualTypeOf<HealthCheckId>();
  });

  it("declares exactly the checks evaluateHealth emits (runtime)", () => {
    const emitted = evaluateHealth(QUIET)
      .checks.map((c) => `health.${c.id}`)
      .sort();
    expect(POLICY_IDS.filter((p) => p.startsWith("health.")).sort()).toEqual(emitted);
  });

  it("gives each threshold knob the same default and legacy env var health.ts uses", () => {
    const withKnobs = POLICY_IDS.filter((p) => policyDef(p).knobs?.threshold);
    expect(withKnobs.map((p) => p.slice("health.".length)).sort()).toEqual(
      Object.keys(THRESHOLD_FIELD).sort(),
    );
    for (const id of withKnobs) {
      const knob = policyDef(id).knobs?.threshold;
      const field = THRESHOLD_FIELD[id.slice("health.".length) as HealthCheckId];
      if (!knob || !field || !knob.legacyEnv)
        throw new Error(`${id}: threshold knob needs a field and legacyEnv`);
      expect(knob.default, id).toBe(DEFAULT_HEALTH_THRESHOLDS[field]);
      // The legacy env var must be the one healthOptionsFromEnv actually reads for that field.
      const probe = String(knob.max);
      expect(healthOptionsFromEnv({ [knob.legacyEnv]: probe }).thresholds?.[field], id).toBe(
        Number(probe),
      );
    }
  });
});
