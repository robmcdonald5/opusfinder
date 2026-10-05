import { describe, expect, it } from "vitest";

import { STAGE_IDS, stageDef } from "@opusfinder/control";

import { createBackfillFunctions, type BackfillDeps } from "./backfill";
import { createDigestFunctions, type DigestDeps } from "./digest";
import { createHealthFunctions, type HealthCheckDeps } from "./health-check";

// The control registry's Inngest stages name their platform function (`platformId`) and copy its cron, but
// the pure registry can't import this package. So the sync lives here and reads the cron ACTUALLY
// registered on each served function (not an exported constant a function could stop using): a schedule
// changed on one side only, or a new cron function with no stage, fails. Building a function only records
// its config, so the deps are never touched.

/** What the serve routes (apps/web /api/inngest, scripts/serve.ts) register, as `{ id, triggers }`. */
const served = [
  ...createDigestFunctions({} as DigestDeps),
  ...createBackfillFunctions({} as BackfillDeps),
  ...createHealthFunctions({} as HealthCheckDeps),
].map((fn) => (fn as unknown as { opts: { id: string; triggers?: unknown } }).opts);

const inngestStages = STAGE_IDS.filter((id) => stageDef(id).runtime === "inngest:opusfinder");

const hasCron = (triggers: unknown): boolean =>
  Array.isArray(triggers) &&
  triggers.some((t: unknown) => typeof t === "object" && t !== null && "cron" in t);

describe("control registry ⇄ Inngest functions", () => {
  it("each Inngest stage names a served function and declares the cron that function registers", () => {
    expect(inngestStages.length).toBeGreaterThan(0);
    for (const id of inngestStages) {
      const def = stageDef(id);
      const fn = served.find((f) => f.id === def.platformId);
      expect(fn, `${id}: no served function "${def.platformId}"`).toBeDefined();
      expect(fn?.triggers, id).toEqual([def.trigger]);
    }
  });

  it("every cron-triggered function is some Inngest stage's platform function", () => {
    expect(
      served
        .filter((f) => hasCron(f.triggers))
        .map((f) => f.id)
        .sort(),
    ).toEqual(inngestStages.map((id) => stageDef(id).platformId).sort());
  });
});
