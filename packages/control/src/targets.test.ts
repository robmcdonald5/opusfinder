import { describe, expect, it } from "vitest";

import {
  REASON_MAX,
  allTargets,
  formatTarget,
  normalizeReason,
  parseTarget,
  parseValue,
  type Target,
} from "./targets";

// The address grammar is shared by the D1 key, the change log, the API and `pnpm ctl`, so a parse
// ambiguity would let two surfaces disagree about WHICH switch a change touched.

function target(address: string): Target {
  const r = parseTarget(address);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function errorOf(r: { ok: true } | { ok: false; error: string }): string {
  if (r.ok) throw new Error("expected a parse error");
  return r.error;
}

describe("parseTarget / formatTarget", () => {
  it("round-trips every settable target", () => {
    const targets = allTargets();
    const addresses = targets.map(formatTarget);
    expect(new Set(addresses).size).toBe(addresses.length);
    for (const t of targets) expect(target(formatTarget(t))).toEqual(t);
  });

  it("parses each address form", () => {
    expect(target("global")).toEqual({ kind: "mode", entry: { type: "global" } });
    expect(target("ingest")).toEqual({ kind: "mode", entry: { type: "stage", id: "ingest" } });
    expect(target("close")).toEqual({ kind: "mode", entry: { type: "policy", id: "close" } });
    expect(target("ingest.boardsPerTick")).toEqual({
      kind: "knob",
      entry: { type: "stage", id: "ingest" },
      knob: "boardsPerTick",
    });
    expect(target("ingest@source=smartrecruiters")).toEqual({
      kind: "dim",
      stage: "ingest",
      dim: "source",
      value: "smartrecruiters",
    });
  });

  it("resolves a dotted policy id before splitting a knob off the last dot", () => {
    expect(target("health.board_fail_ratio")).toEqual({
      kind: "mode",
      entry: { type: "policy", id: "health.board_fail_ratio" },
    });
    expect(target("health.board_fail_ratio.threshold")).toEqual({
      kind: "knob",
      entry: { type: "policy", id: "health.board_fail_ratio" },
      knob: "threshold",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(formatTarget(target("  embed "))).toBe("embed");
  });

  it.each([
    ["", /1-128/],
    ["x".repeat(129), /1-128/],
    ["nope", /unknown target "nope"/],
    ["global.anything", /unknown target/],
    ["ingest.nope", /has no knob "nope" \(has: boardsPerTick\)/],
    ["live_integration.x", /has no knob "x" \(has: none\)/],
    ["nope@source=lever", /unknown stage "nope"/],
    ["ingest@source", /override must look like ingest@<dim>=<value>/],
    ["discover@source=lever", /has no dimension "source" \(has: lane\)/],
    ["embed@source=lever", /has no dimension "source" \(has: none\)/],
    ["ingest@source=nope", /unknown source "nope"/],
    ["ingest@lane=hn", /has no dimension "lane"/],
  ])("rejects %j", (address, message) => {
    expect(errorOf(parseTarget(address))).toMatch(message);
  });
});

describe("parseValue", () => {
  it("accepts only an entry's own modes", () => {
    expect(parseValue(target("embed"), "shadow")).toEqual({ ok: true, value: "shadow" });
    expect(parseValue(target("global"), " off ")).toEqual({ ok: true, value: "off" });
    // ingest offers no shadow (§5.2); close offers no off; global has no shadow.
    expect(errorOf(parseValue(target("ingest"), "shadow"))).toMatch(/takes one of: off, on/);
    expect(errorOf(parseValue(target("close"), "off"))).toMatch(/takes one of: shadow, enforce/);
    expect(errorOf(parseValue(target("global"), "shadow"))).toMatch(/off, on/);
    expect(errorOf(parseValue(target("health.digest_health"), "on"))).toMatch(
      /off, shadow, enforce/,
    );
  });

  it("takes the stage's modes or 'inherit' (= clear) for an override", () => {
    const o = target("ingest@source=lever");
    expect(parseValue(o, "off")).toEqual({ ok: true, value: "off" });
    expect(parseValue(o, "inherit")).toEqual({ ok: true, value: null });
    expect(errorOf(parseValue(o, "shadow"))).toMatch(/off, on, inherit/);
  });

  it("canonicalizes an override at the stage's top mode to 'no override' (it caps nothing)", () => {
    expect(parseValue(target("ingest@source=lever"), "on")).toEqual({ ok: true, value: null });
    expect(parseValue(target("discover@lane=hn"), "on")).toEqual({ ok: true, value: null });
    // A value below the top does cap, so it is kept.
    expect(parseValue(target("ingest@source=lever"), "off")).toEqual({ ok: true, value: "off" });
  });

  it("canonicalizes in-range decimal knob values", () => {
    expect(parseValue(target("ingest.boardsPerTick"), "75")).toEqual({ ok: true, value: "75" });
    expect(parseValue(target("ingest.boardsPerTick"), "75.0")).toEqual({ ok: true, value: "75" });
    expect(parseValue(target("health.board_fail_ratio.threshold"), "0.25")).toEqual({
      ok: true,
      value: "0.25",
    });
    expect(parseValue(target("discover.limit"), "0")).toEqual({ ok: true, value: "0" });
  });

  it.each(["1e2", "0x10", "+5", "Infinity", "NaN", "", "5,0", "05", ".5", "5."])(
    "rejects the non-plain-decimal knob value %j",
    (raw) => {
      expect(errorOf(parseValue(target("ingest.boardsPerTick"), raw))).toMatch(/plain number/);
    },
  );

  it("enforces knob bounds and whole numbers", () => {
    expect(errorOf(parseValue(target("ingest.boardsPerTick"), "0"))).toMatch(/between 1 and 500/);
    expect(errorOf(parseValue(target("ingest.boardsPerTick"), "501"))).toMatch(/between 1 and 500/);
    expect(errorOf(parseValue(target("ingest.boardsPerTick"), "-1"))).toMatch(/between 1 and 500/);
    expect(errorOf(parseValue(target("ingest.boardsPerTick"), "1.5"))).toMatch(/whole number/);
    expect(errorOf(parseValue(target("stale_sweep.ttlDays"), "6"))).toMatch(/between 7 and 90/);
  });
});

describe("normalizeReason", () => {
  it("requires a non-empty string", () => {
    for (const raw of [undefined, null, 42, "", "   ", "\n\t"]) {
      expect(errorOf(normalizeReason(raw))).toMatch(/reason is required/);
    }
  });

  it("folds whitespace and control characters into single spaces", () => {
    expect(normalizeReason("  token\n\nspike\u0007 investigating\t ")).toEqual({
      ok: true,
      value: "token spike investigating",
    });
  });

  it("caps the length at REASON_MAX after normalizing", () => {
    expect(normalizeReason("x".repeat(REASON_MAX))).toEqual({
      ok: true,
      value: "x".repeat(REASON_MAX),
    });
    expect(errorOf(normalizeReason("x".repeat(REASON_MAX + 1)))).toMatch(/at most 300/);
  });
});
