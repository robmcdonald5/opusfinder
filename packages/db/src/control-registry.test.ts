import { describe, expect, expectTypeOf, it } from "vitest";

import { POLICY_IDS, policyDef, type PolicyId } from "@opusfinder/control";

import {
  evaluateHealth,
  healthOptionsFromEnv,
  type HealthCheckId,
  type HealthSignals,
} from "./health";

// The control-plane registry (@opusfinder/control) declares one `health.<id>` policy per health check, but
// it is a pure leaf and may not import this module (db/health reads `process` — the H1 landmine). So the
// sync check lives HERE, in the source of truth, pointing at the registry: a check added to health.ts
// without its registry entry (or vice versa) fails, as does a threshold default or env name that drifts.
// Thresholds are read off evaluateHealth's own output rather than a hand-kept check→field map, so a new
// threshold (or one moved to another check) can't slip past a stale map.

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
  latestIngestHydrateSkipped: 0,
  latestIngestHydrateListed: 0,
  discoveryAgeD: 0,
  discoveryLaneErrors: 0,
  embeddingBacklog: 0,
  digestErrors: 0,
  hardBounces: 0,
  suppressed: 0,
  cost: { digestsConsidered: 0, rerankCacheReadTokens: 0, rerankCacheCreationTokens: 0 },
};

/** The checks as evaluated under `env`; with no env every threshold is DEFAULT_HEALTH_THRESHOLDS'. */
const checksUnder = (env: Record<string, string> = {}) =>
  evaluateHealth(QUIET, healthOptionsFromEnv(env)).checks;

const thresholdKnob = (id: HealthCheckId) => policyDef(`health.${id}` as PolicyId).knobs?.threshold;

describe("control registry ⇄ db/health", () => {
  it("declares exactly one health.<id> policy per HealthCheckId (type level, enforced by typecheck:test)", () => {
    expectTypeOf<RegistryHealthId>().toEqualTypeOf<HealthCheckId>();
  });

  it("declares exactly the checks evaluateHealth emits (runtime)", () => {
    const emitted = checksUnder()
      .map((c) => `health.${c.id}`)
      .sort();
    expect(POLICY_IDS.filter((p) => p.startsWith("health.")).sort()).toEqual(emitted);
  });

  it("gives a check a threshold knob exactly when it has a threshold, defaulting to the one it applies", () => {
    for (const c of checksUnder()) {
      expect(thresholdKnob(c.id)?.default ?? null, c.id).toBe(c.threshold);
    }
  });

  it("names, per threshold knob, the env var healthOptionsFromEnv reads for THAT check and no other", () => {
    const defaults = new Map(checksUnder().map((c) => [c.id, c.threshold]));
    for (const { id } of checksUnder()) {
      const knob = thresholdKnob(id);
      if (!knob) continue;
      if (!knob.legacyEnv) throw new Error(`health.${id}: threshold knob needs a legacyEnv`);
      // knob.max: inside the knob's range and no check's default, so it can only come from the env var,
      // whichever threshold it lands on.
      expect([...defaults.values()], id).not.toContain(knob.max);
      for (const c of checksUnder({ [knob.legacyEnv]: String(knob.max) })) {
        // The probed check takes the value; every other check keeps its no-env default (no cross-wiring).
        expect(c.threshold, `${knob.legacyEnv} → ${c.id}`).toBe(
          c.id === id ? knob.max : defaults.get(c.id),
        );
      }
    }
  });
});
