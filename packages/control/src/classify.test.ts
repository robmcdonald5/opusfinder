import { describe, expect, it } from "vitest";

import { agentRule, classify, direction, type Change, type Role } from "./classify";
import { MODE_RANK, POLICY_IDS, STAGE_IDS, type Mode } from "./registry";
import { desiredValue, type StateMap } from "./resolve";
import {
  INHERIT,
  allTargets,
  entryModes,
  formatTarget,
  knobDef,
  parseTarget,
  parseValue,
  type Target,
} from "./targets";

// classify() is the T2 boundary: the only thing standing between an agent token and turning spend on.
// These tests enumerate the WHOLE registry rather than sampling, so a new entry is covered the moment it
// is declared — and the ratchet test checks the property the rule exists for, not just its cases.

function t(address: string): Target {
  const r = parseTarget(address);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const set = (target: Target, from: string | null, to: string | null): Change => ({
  kind: "set",
  target,
  from,
  to,
});

/**
 * The entries the owner put under "approval" (decisions 2026-10-04): the master switch, the alerts stage
 * and every health check — their modes AND their knobs. `global` and `alerts` are spelled out here rather
 * than read from the registry, so a registry edit that drops either from approval fails these tests
 * instead of silently moving it. The health checks ARE read from the registry (every `health.*` policy),
 * so a new check is covered the moment it is declared, and one that loses its approval rule still fails.
 */
const APPROVAL_ENTRIES = new Set<string>([
  "global",
  "alerts",
  ...POLICY_IDS.filter((p) => p.startsWith("health.")),
]);

const needsApproval = (target: Target) =>
  APPROVAL_ENTRIES.has(
    target.kind === "dim" ? target.stage : formatTarget({ kind: "mode", entry: target.entry }),
  );

/** Every value a target can hold, as stored canonical strings (null = no override). */
function valuesOf(target: Target): (string | null)[] {
  switch (target.kind) {
    case "mode":
      return [...entryModes(target.entry)];
    case "dim": {
      const stage = t(target.stage);
      return [null, ...(stage.kind === "mode" ? entryModes(stage.entry) : [])];
    }
    case "knob": {
      const k = knobDef(target);
      const mid = k.int ? Math.round((k.min + k.max) / 2) : (k.min + k.max) / 2;
      return [...new Set([k.min, k.default, mid, k.max])].map(String);
    }
  }
}

/** Every (target, from, to) with from !== to, over the whole registry. */
function everyMove(filter: (target: Target) => boolean = () => true) {
  const out: { target: Target; from: string | null; to: string | null }[] = [];
  for (const target of allTargets().filter(filter)) {
    const values = valuesOf(target);
    for (const from of values)
      for (const to of values) if (from !== to) out.push({ target, from, to });
  }
  return out;
}

/** A total "riskiness" order per target, independent of classify's own implementation. */
function risk(target: Target, value: string | null): number {
  if (target.kind === "knob") {
    const n = Number(value);
    return knobDef(target).riskier === "up" ? n : -n;
  }
  if (value === null) return 2; // no override = uncapped
  return MODE_RANK[value as Mode];
}

describe("direction", () => {
  it("orders modes off < shadow < on/enforce", () => {
    expect(direction(t("embed"), "on", "shadow")).toBe("down");
    expect(direction(t("embed"), "shadow", "off")).toBe("down");
    expect(direction(t("embed"), "off", "shadow")).toBe("up");
    expect(direction(t("close"), "shadow", "enforce")).toBe("up");
    expect(direction(t("global"), "on", "off")).toBe("down");
    expect(direction(t("embed"), "on", "on")).toBe("none");
  });

  it("follows each knob's declared riskier side", () => {
    expect(direction(t("ingest.boardsPerTick"), "250", "75")).toBe("down");
    expect(direction(t("ingest.boardsPerTick"), "250", "300")).toBe("up");
    // ttlDays: riskier DOWN (a shorter TTL closes more).
    expect(direction(t("stale_sweep.ttlDays"), "21", "30")).toBe("down");
    expect(direction(t("stale_sweep.ttlDays"), "21", "14")).toBe("up");
    // cooldownH: riskier DOWN (a shorter cooldown re-pages sooner: more emails).
    expect(direction(t("alerts.cooldownH"), "24", "6")).toBe("up");
    expect(direction(t("alerts.cooldownH"), "24", "48")).toBe("down");
    expect(direction(t("ingest.boardsPerTick"), "250", "250")).toBe("none");
  });

  it("treats adding an override as down and removing one as up", () => {
    const o = t("ingest@source=lever");
    expect(direction(o, null, "off")).toBe("down");
    expect(direction(o, "off", null)).toBe("up");
    expect(direction(o, "off", "on")).toBe("up");
    expect(direction(o, "on", "off")).toBe("down");
    // An "on" override caps nothing, so adding or removing one changes no rank.
    expect(direction(o, null, "on")).toBe("none");
  });

  it("fails closed on values it can't order", () => {
    expect(direction(t("embed"), "on", "turbo")).toBe("up");
    expect(direction(t("ingest.boardsPerTick"), "250", "lots")).toBe("up");
    expect(direction(t("ingest.boardsPerTick"), "lots", "1")).toBe("up");
  });
});

describe("owner", () => {
  it("applies every move on every target", () => {
    for (const m of everyMove()) {
      expect(classify(set(m.target, m.from, m.to), "owner").outcome).toBe("apply");
    }
  });
});

describe("agent: the safe-direction rule", () => {
  it("applies exactly the moves toward less spend/risk, and proposes the rest (whole registry)", () => {
    let applied = 0;
    let proposed = 0;
    for (const m of everyMove((target) => !needsApproval(target))) {
      const c = classify(set(m.target, m.from, m.to), "agent");
      const safer = risk(m.target, m.to) <= risk(m.target, m.from);
      expect(c.outcome, `${formatTarget(m.target)} ${m.from}→${m.to}`).toBe(
        safer ? "apply" : "propose",
      );
      if (c.outcome === "apply") applied++;
      else proposed++;
    }
    // Both branches are genuinely exercised (guards against a vacuous enumeration).
    expect(applied).toBeGreaterThan(50);
    expect(proposed).toBeGreaterThan(50);
  });

  it("can never turn a stage on, or to shadow, on its own", () => {
    for (const id of STAGE_IDS) {
      for (const to of ["shadow", "on"]) {
        if (!(entryModes({ type: "stage", id }) as readonly string[]).includes(to)) continue;
        expect(classify(set(t(id), "off", to), "agent").outcome).toBe("propose");
      }
      if ((entryModes({ type: "stage", id }) as readonly string[]).includes("shadow")) {
        expect(classify(set(t(id), "shadow", "on"), "agent").outcome).toBe("propose");
      }
    }
    expect(classify(set(t("global"), "off", "on"), "agent").outcome).toBe("propose");
  });

  it("can still stop every single spending stage on its own", () => {
    for (const id of STAGE_IDS.filter((s) => s !== "alerts")) {
      const top = entryModes({ type: "stage", id }).at(-1) ?? "on";
      expect(classify(set(t(id), top, "off"), "agent").outcome, id).toBe("apply");
    }
  });

  it("can never move a policy toward enforce on its own", () => {
    expect(classify(set(t("close"), "shadow", "enforce"), "agent").outcome).toBe("propose");
    expect(classify(set(t("stale_sweep"), "shadow", "enforce"), "agent").outcome).toBe("propose");
  });

  it("can turn things off, lower spend knobs and add narrowing overrides on its own", () => {
    expect(classify(set(t("embed"), "on", "off"), "agent").outcome).toBe("apply");
    expect(classify(set(t("close"), "enforce", "shadow"), "agent").outcome).toBe("apply");
    expect(classify(set(t("embed.tokensPerRun"), "10000000", "5000000"), "agent").outcome).toBe(
      "apply",
    );
    expect(classify(set(t("ingest@source=smartrecruiters"), null, "off"), "agent").outcome).toBe(
      "apply",
    );
  });

  it("must propose removing an override or raising a spend knob", () => {
    expect(classify(set(t("ingest@source=smartrecruiters"), "off", null), "agent").outcome).toBe(
      "propose",
    );
    expect(classify(set(t("ingest.boardsPerTick"), "250", "400"), "agent").outcome).toBe("propose");
    expect(classify(set(t("stale_sweep.ttlDays"), "21", "7"), "agent").outcome).toBe("propose");
  });

  it("treats a no-op as applied (nothing changes)", () => {
    const c = classify(set(t("embed"), "off", "off"), "agent");
    expect(c).toMatchObject({ outcome: "apply", direction: "none" });
  });
});

describe("agent: global, alerts and the health checks need approval for ANY change (registry rule)", () => {
  const approvalMoves = everyMove(needsApproval);

  it("covers global, alerts (+ its cooldown knob), every check and their threshold knobs", () => {
    const touched = new Set(approvalMoves.map((m) => formatTarget(m.target)));
    for (const id of APPROVAL_ENTRIES) expect(touched).toContain(id);
    expect(touched).toContain("alerts.cooldownH");
    expect(touched).toContain("health.board_fail_ratio.threshold");
    expect(touched).toContain("health.embedding_backlog.threshold");
  });

  it("derives the rule for knobs from their entry", () => {
    expect(agentRule(t("alerts.cooldownH"))).toBe("approval");
    expect(agentRule(t("health.board_fail_ratio.threshold"))).toBe("approval");
    expect(agentRule(t("ingest.boardsPerTick"))).toBe("safe-direction");
  });

  it("proposes every move — quieter AND louder", () => {
    for (const m of approvalMoves) {
      const c = classify(set(m.target, m.from, m.to), "agent");
      expect(c.outcome, `${formatTarget(m.target)} ${m.from}→${m.to}`).toBe("propose");
    }
  });

  it("explicitly: silencing alerts, a quieter check and the master switch off are all proposals", () => {
    const quieter = [
      set(t("global"), "on", "off"),
      set(t("alerts"), "on", "off"),
      set(t("alerts.cooldownH"), "24", "168"),
      set(t("alerts.cooldownH"), "24", "1"),
      set(t("health.ingestion_staleness"), "enforce", "shadow"),
      set(t("health.ingestion_staleness"), "shadow", "off"),
      set(t("health.board_fail_ratio.threshold"), "0.5", "0.9"),
      set(t("health.board_fail_ratio.threshold"), "0.5", "0.1"),
    ];
    for (const c of quieter) expect(classify(c, "agent").outcome).toBe("propose");
  });

  it("still lets the owner change them directly", () => {
    expect(classify(set(t("health.digest_health"), "shadow", "enforce"), "owner").outcome).toBe(
      "apply",
    );
  });
});

describe("runtime", () => {
  it("may trip a stage off — and nothing else", () => {
    for (const m of everyMove()) {
      const c = classify(set(m.target, m.from, m.to), "runtime");
      const isStageOff =
        m.target.kind === "mode" && m.target.entry.type === "stage" && m.to === "off";
      expect(c.outcome, `${formatTarget(m.target)} ${m.from}→${m.to}`).toBe(
        isStageOff ? "apply" : "deny",
      );
    }
  });

  it("can't turn the master switch off or propose anything", () => {
    expect(classify(set(t("global"), "on", "off"), "runtime").outcome).toBe("deny");
    expect(classify(set(t("embed"), "off", "on"), "runtime").outcome).toBe("deny");
  });
});

describe("posture repairs", () => {
  const repair: Change = {
    kind: "posture",
    stage: "live_integration",
    action: "gh workflow enable",
  };
  it.each<[Role, string]>([
    ["owner", "apply"],
    ["agent", "apply"],
    ["runtime", "deny"],
  ])("%s → %s", (role, outcome) => {
    expect(classify(repair, role).outcome).toBe(outcome);
  });
});

describe("the ratchet: agent-applied changes never raise spend or risk", () => {
  // A seeded random walk: an agent fires arbitrary set requests; only the ones classify() lets it APPLY
  // take effect. Across the whole walk no target's riskiness may ever increase. This is the property
  // the rule exists for ("worst case, an agent mistake stops something").
  function lcg(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  it.each([1, 7, 42, 2026])("holds for a 5000-step random walk (seed %i)", (seed) => {
    const rand = lcg(seed);
    const targets = allTargets();
    const rows = new Map<string, string>();
    const state: StateMap = rows;
    let applied = 0;
    for (let step = 0; step < 5000; step++) {
      const target = targets[Math.floor(rand() * targets.length)]!;
      const values = valuesOf(target);
      const pick = values[Math.floor(rand() * values.length)] ?? null;
      const parsed = parseValue(target, pick === null ? INHERIT : pick);
      if (!parsed.ok) throw new Error(parsed.error);
      const from = desiredValue(state, target);
      const c = classify(set(target, from, parsed.value), "agent");
      if (c.outcome !== "apply") continue;
      const before = risk(target, from);
      const key = formatTarget(target);
      if (parsed.value === null) rows.delete(key);
      else rows.set(key, parsed.value);
      expect(risk(target, desiredValue(state, target))).toBeLessThanOrEqual(before);
      applied++;
    }
    expect(applied).toBeGreaterThan(100);
  });
});
