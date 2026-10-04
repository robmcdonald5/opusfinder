// classify(change, role) — the ONE policy function deciding whether a caller may apply a change itself,
// must propose it to the owner, or may not touch it at all (§11.2, T2). The API, the page and `pnpm ctl`
// all call this; nothing else re-derives the rule.
//
// The safe-direction rule (a RATCHET): order every value from less spend/risk to more. A move toward LESS
// is safe, so an agent may make it on its own; a move toward MORE needs the owner. Worst case under this
// rule, an agent mistake STOPS something — it can never start spending money. Concretely:
//   - a mode moving down its order (on → shadow → off, enforce → shadow → off; global → off);
//   - a knob moving opposite its declared `riskier` side;
//   - ADDING a narrowing override (an override can only cap, so a new one is never "more on");
// are "down". Turning on, moving toward enforce, raising a spend knob and REMOVING an override (which
// un-caps the slice) are "up". Per-entry exceptions are declared on the registry entry (`agent:
// "approval"` — the health checks), never special-cased here.
//
// Roles (credential = role, §11.1):
//   owner   — applies anything (a human Access login; the person whose decision this is).
//   agent   — applies "down"/no-op moves on safe-direction entries; everything else becomes a proposal.
//             Posture repairs are agent-safe: re-asserting platform posture (re-enabling an auto-disabled
//             GitHub workflow, un-pausing an Inngest function) changes no desired state, and under
//             fire-and-check the gate still decides whether anything runs.
//   runtime — may only TRIP a stage off (runaway / error-storm guard). It can't propose, and it can't
//             touch global, policies, knobs or overrides.
import {
  MODE_RANK,
  TOP_RANK,
  globalSwitch,
  policyDef,
  stageDef,
  type AgentRule,
  type Mode,
  type StageId,
} from "./registry";
import { formatTarget, knobDef, type Target } from "./targets";

export type Role = "owner" | "agent" | "runtime";
export const ROLES: readonly Role[] = ["owner", "agent", "runtime"];

/**
 * A proposed change. `from`/`to` are the RESOLVED desired values (resolve.desiredValue), canonical
 * strings; `null` means "no override" and is only meaningful for a dimension target.
 */
export type Change =
  | { kind: "set"; target: Target; from: string | null; to: string | null }
  | { kind: "posture"; stage: StageId; action: string };

export type Direction = "down" | "up" | "none";

export interface Classification {
  outcome: "apply" | "propose" | "deny";
  direction: Direction;
  /** One line for humans and agents: which rule decided. */
  rule: string;
}

function modeRank(value: string | null): number {
  // `null` = no override = no cap: the top of the order. An unrecognised string can only come from a
  // caller bypassing parseValue; rank it at the top so it can never look like a safe "down" move.
  if (value === null) return TOP_RANK;
  return Object.hasOwn(MODE_RANK, value) ? MODE_RANK[value as Mode] : Number.POSITIVE_INFINITY;
}

/** Which way a change moves the ratchet. */
export function direction(target: Target, from: string | null, to: string | null): Direction {
  if (from === to) return "none";
  if (target.kind === "knob") {
    const a = Number(from);
    const b = Number(to);
    // Non-numeric input can't be ordered; treat it as the risky side (fail-closed).
    if (!Number.isFinite(a) || !Number.isFinite(b)) return "up";
    if (a === b) return "none";
    const increasing = b > a;
    return increasing === (knobDef(target).riskier === "up") ? "up" : "down";
  }
  const a = modeRank(from);
  const b = modeRank(to);
  if (a === b) return "none";
  return b < a ? "down" : "up";
}

/** The agent rule declared on the target's registry entry (dimension overrides follow their stage). */
export function agentRule(target: Target): AgentRule {
  const entry =
    target.kind === "dim" ? ({ type: "stage", id: target.stage } as const) : target.entry;
  switch (entry.type) {
    case "global":
      return globalSwitch.agent;
    case "stage":
      return stageDef(entry.id).agent ?? "safe-direction";
    case "policy":
      return policyDef(entry.id).agent ?? "safe-direction";
  }
}

export function classify(change: Change, role: Role): Classification {
  if (change.kind === "posture") {
    if (role === "runtime") {
      return { outcome: "deny", direction: "none", rule: "runtimes don't repair platform posture" };
    }
    return {
      outcome: "apply",
      direction: "none",
      rule: "posture repair re-asserts platform posture; desired state is unchanged",
    };
  }

  const { target, from, to } = change;
  const dir = direction(target, from, to);
  const name = formatTarget(target);

  switch (role) {
    case "owner":
      return { outcome: "apply", direction: dir, rule: "the owner may apply any change" };

    case "runtime": {
      const isStageMode = target.kind === "mode" && target.entry.type === "stage";
      if (isStageMode && to === "off") {
        return { outcome: "apply", direction: dir, rule: "a runtime may trip a stage off" };
      }
      return {
        outcome: "deny",
        direction: dir,
        rule: "a runtime may only trip a stage off; it can't set anything else or propose",
      };
    }

    case "agent": {
      if (dir === "none") {
        return { outcome: "apply", direction: dir, rule: `no change: ${name} is already ${to}` };
      }
      if (agentRule(target) === "approval") {
        return {
          outcome: "propose",
          direction: dir,
          rule: `${name}: any agent change needs owner approval (registry rule "approval")`,
        };
      }
      if (dir === "down") {
        return {
          outcome: "apply",
          direction: dir,
          rule: `${name}: a move toward less spend/risk is agent-safe`,
        };
      }
      return {
        outcome: "propose",
        direction: dir,
        rule: `${name}: a move toward more spend/risk needs owner approval`,
      };
    }
  }
}
