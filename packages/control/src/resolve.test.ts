import { describe, expect, it } from "vitest";

import { POLICY_IDS, STAGE_IDS, policies, stages } from "./registry";
import {
  desiredMode,
  desiredValue,
  effectiveAll,
  effectiveMode,
  knobValue,
  overrideMode,
  type StateMap,
} from "./resolve";
import { parseTarget, type Target } from "./targets";

// The fail-closed read path (§3.3, owner decision: everywhere, ingest included) and the dimension-
// narrowing rule (§5.1: effective = lowest of global, stage, override; nothing more on than its stage).

const state = (rows: Record<string, string> = {}): StateMap => new Map(Object.entries(rows));

function knob(address: string): Extract<Target, { kind: "knob" }> {
  const r = parseTarget(address);
  if (!r.ok || r.value.kind !== "knob") throw new Error(`not a knob: ${address}`);
  return r.value;
}

describe("fail-closed layer 1: a missing row is the registry default", () => {
  it("resolves an empty store to the registry's initial modes, all marked 'default'", () => {
    const empty = state();
    expect(desiredMode(empty, { type: "global" })).toEqual({ value: "on", source: "default" });
    for (const id of STAGE_IDS) {
      expect(desiredMode(empty, { type: "stage", id })).toEqual({
        value: stages[id].initial,
        source: "default",
      });
    }
    for (const id of POLICY_IDS) {
      expect(desiredMode(empty, { type: "policy", id })).toEqual({
        value: policies[id].initial,
        source: "default",
      });
    }
  });

  it("resolves a missing knob to its default and a missing override to 'no override'", () => {
    expect(knobValue(state(), knob("ingest.boardsPerTick"))).toEqual({
      value: 150,
      source: "default",
    });
    expect(overrideMode(state(), "ingest", "source", "lever")).toEqual({
      value: null,
      source: "default",
    });
  });

  it("reads a stored row as 'set'", () => {
    const s = state({ embed: "shadow", "ingest.boardsPerTick": "75" });
    expect(desiredMode(s, { type: "stage", id: "embed" })).toEqual({
      value: "shadow",
      source: "set",
    });
    expect(knobValue(s, knob("ingest.boardsPerTick"))).toEqual({ value: 75, source: "set" });
  });
});

describe("fail-closed layer 2: an unrecognised value is off", () => {
  it.each([
    ["a garbage mode", "ingest", "maybe"],
    ["a mode this stage doesn't offer", "ingest", "shadow"],
    ["a policy mode on a stage", "embed", "enforce"],
    ["an empty string", "digest", ""],
    ["wrong case", "cv_ingest", "ON"],
  ])("reads %s as off", (_label, key, raw) => {
    const r = parseTarget(key);
    if (!r.ok || r.value.kind !== "mode") throw new Error("bad key");
    expect(desiredMode(state({ [key]: raw }), r.value.entry)).toEqual({
      value: "off",
      source: "invalid",
    });
  });

  it("reads an unrecognised policy value as off even when the policy offers no 'off' mode", () => {
    // close settable modes are shadow|enforce; the safe reading of "unknown" is still "not enforcing".
    expect(desiredMode(state({ close: "enforced" }), { type: "policy", id: "close" })).toEqual({
      value: "off",
      source: "invalid",
    });
    expect(effectiveMode(state({ close: "garbage" }), { policy: "close" }).mode).toBe("off");
  });

  it("reads an unrecognised GLOBAL value as off — which turns everything off", () => {
    const all = effectiveAll(state({ global: "yes" }));
    expect(all.global).toBe("off");
    expect(new Set(Object.values(all.stages))).toEqual(new Set(["off"]));
    expect(new Set(Object.values(all.policies))).toEqual(new Set(["off"]));
  });

  it("reads an unrecognised override as an 'off' override (narrows, never widens)", () => {
    const s = state({ "ingest@source=lever": "bogus" });
    expect(overrideMode(s, "ingest", "source", "lever")).toEqual({
      value: "off",
      source: "invalid",
    });
    expect(effectiveMode(s, { stage: "ingest", dims: { source: "lever" } }).mode).toBe("off");
  });

  it.each([
    ["non-numeric", "lots"],
    ["empty", ""],
    ["whitespace", "  "],
    ["above max", "501"],
    ["below min", "0"],
    ["fractional on an int knob", "12.5"],
    ["infinite", "Infinity"],
  ])("reads a %s knob as its least-risky bound", (_label, raw) => {
    // riskier "up" → the minimum.
    expect(knobValue(state({ "ingest.boardsPerTick": raw }), knob("ingest.boardsPerTick"))).toEqual(
      {
        value: 1,
        source: "invalid",
      },
    );
  });

  it("reads an invalid riskier-'down' knob as its MAXIMUM (a longer TTL closes less)", () => {
    expect(knobValue(state({ "stale_sweep.ttlDays": "3" }), knob("stale_sweep.ttlDays"))).toEqual({
      value: 90,
      source: "invalid",
    });
  });
});

describe("effective mode: the lowest of global, stage and override", () => {
  it("passes the stage's desired mode through when nothing caps it", () => {
    expect(effectiveMode(state({ digest: "shadow" }), { stage: "digest" })).toEqual({
      mode: "shadow",
      desired: "shadow",
      cappedBy: null,
    });
  });

  it("caps every stage and policy at off when the master switch is off", () => {
    const s = state({ global: "off" });
    expect(effectiveMode(s, { stage: "ingest" })).toEqual({
      mode: "off",
      desired: "on",
      cappedBy: "global",
    });
    expect(effectiveMode(s, { policy: "close" })).toEqual({
      mode: "off",
      desired: "enforce",
      cappedBy: "global",
    });
    expect(effectiveMode(s, "global")).toEqual({ mode: "off", desired: "off", cappedBy: null });
  });

  it("does not report a global cap on a stage that is already off", () => {
    expect(effectiveMode(state({ global: "off" }), { stage: "embed" }).cappedBy).toBeNull();
  });

  it("narrows one slice with an override while the stage and its other slices stay on", () => {
    const s = state({ "ingest@source=smartrecruiters": "off" });
    expect(effectiveMode(s, { stage: "ingest", dims: { source: "smartrecruiters" } })).toEqual({
      mode: "off",
      desired: "on",
      cappedBy: "source=smartrecruiters",
    });
    expect(effectiveMode(s, { stage: "ingest", dims: { source: "lever" } }).mode).toBe("on");
    expect(effectiveMode(s, { stage: "ingest" }).mode).toBe("on");
  });

  it("never lets an override make a slice MORE on than its stage", () => {
    // stage off + override on → off; stage shadow + override on → shadow.
    const off = state({ ingest: "off", "ingest@source=lever": "on" });
    expect(effectiveMode(off, { stage: "ingest", dims: { source: "lever" } })).toEqual({
      mode: "off",
      desired: "off",
      cappedBy: null,
    });
    const shadow = state({ digest: "shadow" });
    expect(effectiveMode(shadow, { stage: "digest" }).mode).toBe("shadow");
  });

  it("never lets an override lift a slice above a global off", () => {
    const s = state({ global: "off", "ingest@source=lever": "on" });
    expect(effectiveMode(s, { stage: "ingest", dims: { source: "lever" } }).mode).toBe("off");
  });

  it("lets an unknown dimension value inherit its stage (narrowing is additive)", () => {
    const s = state({ "ingest@source=lever": "off" });
    expect(effectiveMode(s, { stage: "ingest", dims: { source: "brand-new-ats" } }).mode).toBe(
      "on",
    );
  });

  it("ignores a dimension the stage doesn't have", () => {
    const s = state({ "ingest@source=lever": "off" });
    // discover is narrowed by lane, not source — a stray source dim must not cap it.
    expect(effectiveMode(s, { stage: "discover", dims: { source: "lever" } }).mode).toBe("on");
  });
});

describe("desiredValue", () => {
  it("returns the canonical string the change log records", () => {
    const s = state({ "ingest@source=lever": "off", "ingest.boardsPerTick": "75" });
    const t = (a: string) => {
      const r = parseTarget(a);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    expect(desiredValue(s, t("ingest"))).toBe("on");
    expect(desiredValue(s, t("ingest.boardsPerTick"))).toBe("75");
    expect(desiredValue(s, t("ingest@source=lever"))).toBe("off");
    expect(desiredValue(s, t("ingest@source=gem"))).toBeNull();
  });
});
