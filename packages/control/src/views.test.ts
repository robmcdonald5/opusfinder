import { describe, expect, it } from "vitest";

import { POLICY_IDS, STAGE_IDS } from "./registry";
import type { StateMap } from "./resolve";
import { gateView, policyView, stageView, stateViews } from "./views";

// The read models the API, page and gate share. Pinned on the seed state (today's reality) plus the
// narrowing and master-switch cases a runtime must obey.

const state = (rows: Record<string, string> = {}): StateMap => new Map(Object.entries(rows));

describe("gateView", () => {
  it("answers the ingest tick's 'may I run, and with what settings?' in one read", () => {
    expect(gateView(state(), "ingest")).toEqual({
      stage: "ingest",
      mode: "on",
      desired: "on",
      cappedBy: null,
      global: "on",
      knobs: { boardsPerTick: 150, concurrency: 1 },
      policies: {
        close: { mode: "enforce", knobs: {} },
        stale_sweep: { mode: "shadow", knobs: { ttlDays: 21 } },
      },
      overrides: {},
      onUnreadable: "skip",
    });
  });

  it("lists the narrowing overrides a tick must apply per slice", () => {
    const s = state({ "ingest@source=smartrecruiters": "off", "ingest@source=lever": "on" });
    expect(gateView(s, "ingest").overrides).toEqual({
      source: { smartrecruiters: "off", lever: "on" },
    });
    expect(gateView(s, "ingest", { source: "smartrecruiters" })).toMatchObject({
      mode: "off",
      desired: "on",
      cappedBy: "source=smartrecruiters",
    });
  });

  it("reports everything off under a global off, policies included", () => {
    const g = gateView(state({ global: "off" }), "ingest");
    expect(g).toMatchObject({ mode: "off", cappedBy: "global", global: "off" });
    expect(g.policies.close?.mode).toBe("off");
    expect(
      gateView(state({ global: "off", "ingest@source=gem": "on" }), "ingest").overrides,
    ).toEqual({
      source: { gem: "off" },
    });
  });

  it("gives the alerts stage all 7 health checks with their thresholds", () => {
    const g = gateView(state(), "alerts");
    expect(Object.keys(g.policies).sort()).toEqual(
      POLICY_IDS.filter((p) => p.startsWith("health.")).sort(),
    );
    expect(g.policies["health.board_fail_ratio"]).toEqual({
      mode: "shadow",
      knobs: { threshold: 0.5 },
    });
  });
});

describe("stage / policy views", () => {
  it("covers every registry entry", () => {
    const v = stateViews(state());
    expect(v.stages.map((s) => s.id)).toEqual(STAGE_IDS);
    expect(v.policies.map((p) => p.id)).toEqual(POLICY_IDS);
    expect(v.global).toMatchObject({ desired: "on", source: "default" });
  });

  it("shows set overrides with their effective mode and every known slice for forms", () => {
    const v = stageView(state({ "ingest@source=gem": "off" }), "ingest");
    expect(v.overrides).toEqual([
      {
        target: "ingest@source=gem",
        dim: "source",
        value: "gem",
        override: "off",
        source: "set",
        effective: "off",
      },
    ]);
    expect(v.dims.source).toContain("smartrecruiters");
    expect(v.knobs.map((k) => k.target)).toEqual(["ingest.boardsPerTick", "ingest.concurrency"]);
  });

  it("flags a health check whose watched stage is off (C6: skipped, not failing)", () => {
    expect(policyView(state(), "health.embedding_backlog").watchedStageOff).toBe(true);
    expect(policyView(state(), "health.ingestion_staleness").watchedStageOff).toBe(false);
    expect(policyView(state({ ingest: "off" }), "health.ingestion_staleness").watchedStageOff).toBe(
      true,
    );
    expect(policyView(state(), "close").watchedStageOff).toBeUndefined();
  });

  it("exposes the per-entry agent rule so agents can read it before trying", () => {
    expect(policyView(state(), "health.digest_health").agent).toBe("approval");
    expect(policyView(state(), "health.board_fail_ratio").knobs[0]?.agent).toBe("approval");
    expect(stageView(state(), "embed").agent).toBe("safe-direction");
  });
});
