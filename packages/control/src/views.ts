// Read models built from the raw `state` rows: one shape per surface, computed in ONE place so the JSON
// status, the gate answer and the page can't disagree about what is on. Pure — the Worker adds the
// D1-backed parts (last ledger row, recent changes, open proposals) around these.
import { agentRule } from "./classify";
import {
  DIMENSIONS,
  POLICY_IDS,
  STAGE_IDS,
  globalSwitch,
  policyDef,
  stageDef,
  type AgentRule,
  type DimKey,
  type GlobalMode,
  type Knob,
  type PolicyId,
  type PolicyMode,
  type StageDef,
  type StageId,
  type StageMode,
} from "./registry";
import {
  desiredMode,
  effectiveMode,
  knobValue,
  overrideMode,
  type CappedBy,
  type StateMap,
  type ValueSource,
} from "./resolve";
import { entryKnobs, formatTarget, type EntryRef } from "./targets";

export interface KnobView extends Knob {
  target: string;
  name: string;
  value: number;
  source: ValueSource;
  agent: AgentRule;
}

export interface OverrideView {
  target: string;
  dim: DimKey;
  value: string;
  override: StageMode;
  source: ValueSource;
  /** min(stage effective, override). */
  effective: StageMode;
}

export interface GlobalView {
  target: "global";
  label: string;
  modes: readonly GlobalMode[];
  desired: GlobalMode;
  source: ValueSource;
  agent: AgentRule;
}

export interface StageView extends Pick<
  StageDef,
  "label" | "runtime" | "trigger" | "modes" | "shadowMeans" | "units" | "budget" | "expect"
> {
  id: StageId;
  target: string;
  desired: StageMode;
  source: ValueSource;
  effective: StageMode;
  cappedBy: CappedBy;
  agent: AgentRule;
  onUnreadable: "skip";
  knobs: KnobView[];
  /** The dimensions this stage can be narrowed by, with every known value (for forms). */
  dims: Partial<Record<DimKey, readonly string[]>>;
  /** Overrides that are actually set. */
  overrides: OverrideView[];
}

export interface PolicyView {
  id: PolicyId;
  target: string;
  label: string;
  modes: readonly PolicyMode[];
  desired: PolicyMode;
  source: ValueSource;
  effective: PolicyMode;
  cappedBy: CappedBy;
  readBy: readonly StageId[];
  watches?: StageId;
  /** C6: a health check whose watched stage is off reports "skipped (stage off)". */
  watchedStageOff?: boolean;
  agent: AgentRule;
  knobs: KnobView[];
}

function knobViews(entry: Exclude<EntryRef, { type: "global" }>, state: StateMap): KnobView[] {
  return Object.entries(entryKnobs(entry)).map(([name, knob]) => {
    const target = { kind: "knob", entry, knob: name } as const;
    const resolved = knobValue(state, target);
    return {
      ...knob,
      target: formatTarget(target),
      name,
      value: resolved.value,
      source: resolved.source,
      agent: agentRule(target),
    };
  });
}

export function globalView(state: StateMap): GlobalView {
  const d = desiredMode(state, { type: "global" });
  return {
    target: "global",
    label: globalSwitch.label,
    modes: globalSwitch.modes,
    desired: d.value,
    source: d.source,
    agent: globalSwitch.agent,
  };
}

export function stageView(state: StateMap, id: StageId): StageView {
  const def = stageDef(id);
  const entry = { type: "stage", id } as const;
  const d = desiredMode(state, entry);
  const eff = effectiveMode(state, { stage: id });
  const dims: Partial<Record<DimKey, readonly string[]>> = {};
  const overrides: OverrideView[] = [];
  for (const dim of def.dims ?? []) {
    dims[dim] = DIMENSIONS[dim];
    for (const value of DIMENSIONS[dim]) {
      const o = overrideMode(state, id, dim, value);
      if (o.value === null) continue;
      overrides.push({
        target: formatTarget({ kind: "dim", stage: id, dim, value }),
        dim,
        value,
        override: o.value,
        source: o.source,
        effective: effectiveMode(state, { stage: id, dims: { [dim]: value } }).mode,
      });
    }
  }
  return {
    id,
    target: id,
    label: def.label,
    runtime: def.runtime,
    trigger: def.trigger,
    modes: def.modes,
    shadowMeans: def.shadowMeans,
    units: def.units,
    budget: def.budget,
    expect: def.expect,
    desired: d.value,
    source: d.source,
    effective: eff.mode,
    cappedBy: eff.cappedBy,
    agent: agentRule({ kind: "mode", entry }),
    onUnreadable: def.onUnreadable,
    knobs: knobViews(entry, state),
    dims,
    overrides,
  };
}

export function policyView(state: StateMap, id: PolicyId): PolicyView {
  const def = policyDef(id);
  const entry = { type: "policy", id } as const;
  const d = desiredMode(state, entry);
  const eff = effectiveMode(state, { policy: id });
  return {
    id,
    target: id,
    label: def.label,
    modes: def.modes,
    desired: d.value,
    source: d.source,
    effective: eff.mode,
    cappedBy: eff.cappedBy,
    readBy: def.readBy,
    ...(def.watches
      ? {
          watches: def.watches,
          watchedStageOff: effectiveMode(state, { stage: def.watches }).mode === "off",
        }
      : {}),
    agent: agentRule({ kind: "mode", entry }),
    knobs: knobViews(entry, state),
  };
}

export function stateViews(state: StateMap): {
  global: GlobalView;
  stages: StageView[];
  policies: PolicyView[];
} {
  return {
    global: globalView(state),
    stages: STAGE_IDS.map((id) => stageView(state, id)),
    policies: POLICY_IDS.map((id) => policyView(state, id)),
  };
}

/**
 * The answer to a runtime's "may I run, and with what settings?" (§2 fire-and-check) — everything one
 * tick needs in ONE read: its effective mode, its knobs, the policies it reads and the narrowing
 * overrides it must apply per slice (e.g. skip sources whose effective mode is off).
 */
export interface GateView {
  stage: StageId;
  /** What to obey. With `dims` given, already narrowed to that slice. */
  mode: StageMode;
  desired: StageMode;
  cappedBy: CappedBy;
  global: GlobalMode;
  knobs: Record<string, number>;
  policies: Record<string, { mode: PolicyMode; knobs: Record<string, number> }>;
  /** Effective mode for every slice that has an override set, per dimension. */
  overrides: Partial<Record<DimKey, Record<string, StageMode>>>;
  onUnreadable: "skip";
}

export function gateView(
  state: StateMap,
  stage: StageId,
  dims?: Partial<Record<DimKey, string>>,
): GateView {
  const view = stageView(state, stage);
  const eff = effectiveMode(state, { stage, dims });
  const knobs: Record<string, number> = {};
  for (const k of view.knobs) knobs[k.name] = k.value;
  const policiesOut: GateView["policies"] = {};
  for (const id of POLICY_IDS) {
    if (!(policyDef(id).readBy as readonly string[]).includes(stage)) continue;
    const p = policyView(state, id);
    const pk: Record<string, number> = {};
    for (const k of p.knobs) pk[k.name] = k.value;
    policiesOut[id] = { mode: p.effective, knobs: pk };
  }
  const overrides: GateView["overrides"] = {};
  for (const o of view.overrides) (overrides[o.dim] ??= {})[o.value] = o.effective;
  return {
    stage,
    mode: eff.mode,
    desired: eff.desired,
    cappedBy: eff.cappedBy,
    global: desiredMode(state, { type: "global" }).value,
    knobs,
    policies: policiesOut,
    overrides,
    onUnreadable: view.onUnreadable,
  };
}
