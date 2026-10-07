// Resolving stored state into desired and EFFECTIVE values — the fail-closed read path (§3.3, §5.1).
//
// Fail-closed, in three layers (owner decision 2026-10-04: everywhere, ingest included):
//   1. a MISSING row  → the registry default (`initial` / knob `default`; no override for a dimension);
//   2. an UNRECOGNISED stored value → `off` for a mode or override, the LEAST risky bound for a knob;
//   3. an UNREACHABLE store → the caller skips the stage (that one lives in the runtime gate clients and
//      the Worker's 503, not here — this module only ever sees rows that were read).
// Layer 2 should never fire (every write is validated by targets.parseValue), but a break-glass
// `wrangler d1 execute` or a registry edit that drops a mode can leave a stale value behind, and the safe
// reading of "I don't know what this says" is "off".
//
// Effective mode = the LOWEST of (global, entry, dimension override). Overrides can therefore only narrow:
// nothing can be more on than its stage, and nothing is on while the master switch is off.
import {
  MODE_RANK,
  POLICY_IDS,
  STAGE_IDS,
  globalSwitch,
  policyDef,
  stageDef,
  type DimKey,
  type GlobalMode,
  type Knob,
  type Mode,
  type PolicyId,
  type PolicyMode,
  type StageId,
  type StageMode,
} from "./registry";
import { entryKnobs, entryModes, formatTarget, type EntryRef, type Target } from "./targets";

/** Raw `state` rows: target address → stored value. */
export type StateMap = ReadonlyMap<string, string>;

/** Where a resolved value came from: a stored row, the registry default, or a fail-closed substitute. */
export type ValueSource = "set" | "default" | "invalid";

export interface Resolved<V> {
  value: V;
  source: ValueSource;
}

function rank(mode: Mode): number {
  return MODE_RANK[mode];
}

/** The desired (stored or default) mode of an entry, failing closed to `off` on an unrecognised value. */
export function desiredMode(state: StateMap, entry: { type: "global" }): Resolved<GlobalMode>;
export function desiredMode(
  state: StateMap,
  entry: { type: "stage"; id: StageId },
): Resolved<StageMode>;
export function desiredMode(
  state: StateMap,
  entry: { type: "policy"; id: PolicyId },
): Resolved<PolicyMode>;
export function desiredMode(state: StateMap, entry: EntryRef): Resolved<Mode>;
export function desiredMode(state: StateMap, entry: EntryRef): Resolved<Mode> {
  const key = formatTarget({ kind: "mode", entry });
  const raw = state.get(key);
  if (raw === undefined) {
    const initial =
      entry.type === "global"
        ? globalSwitch.initial
        : entry.type === "stage"
          ? stageDef(entry.id).initial
          : policyDef(entry.id).initial;
    return { value: initial, source: "default" };
  }
  if ((entryModes(entry) as readonly string[]).includes(raw)) {
    return { value: raw as Mode, source: "set" };
  }
  return { value: "off", source: "invalid" };
}

/**
 * A dimension override for one value (e.g. ingest@source=smartrecruiters). `null` = no override (the
 * slice inherits its stage). An unrecognised stored value narrows to `off` (fail-closed).
 */
export function overrideMode(
  state: StateMap,
  stage: StageId,
  dim: DimKey,
  value: string,
): Resolved<StageMode | null> {
  const raw = state.get(formatTarget({ kind: "dim", stage, dim, value }));
  if (raw === undefined) return { value: null, source: "default" };
  if ((stageDef(stage).modes as readonly string[]).includes(raw)) {
    return { value: raw as StageMode, source: "set" };
  }
  return { value: "off", source: "invalid" };
}

/** The least risky end of a knob's range — the fail-closed reading of an unusable stored value. */
export function safestKnobValue(knob: Knob): number {
  return knob.riskier === "up" ? knob.min : knob.max;
}

export function knobValue(
  state: StateMap,
  target: Extract<Target, { kind: "knob" }>,
): Resolved<number> {
  const knob = entryKnobs(target.entry)[target.knob];
  if (!knob) throw new Error(`unknown knob ${formatTarget(target)}`);
  const raw = state.get(formatTarget(target));
  if (raw === undefined) return { value: knob.default, source: "default" };
  const n = raw.trim() === "" ? Number.NaN : Number(raw);
  const valid =
    Number.isFinite(n) && n >= knob.min && n <= knob.max && (!knob.int || Number.isInteger(n));
  return valid ? { value: n, source: "set" } : { value: safestKnobValue(knob), source: "invalid" };
}

/** What capped an effective mode below the entry's own desired mode. */
export type CappedBy = null | "global" | `${DimKey}=${string}`;

export interface Effective<M extends Mode = Mode> {
  /** What the runtime must obey. */
  mode: M;
  /** The entry's own desired mode (before global / override capping). */
  desired: M;
  cappedBy: CappedBy;
}

/**
 * The effective mode of a stage (optionally narrowed to one slice of each dimension), a policy, or the
 * global switch. A dimension value with no override — including one this registry doesn't know yet —
 * inherits the stage: narrowing is additive, so an unknown slice can't be MORE on than its stage.
 */
export function effectiveMode(state: StateMap, ref: "global"): Effective<GlobalMode>;
export function effectiveMode(
  state: StateMap,
  ref: { stage: StageId; dims?: Partial<Record<DimKey, string>> },
): Effective<StageMode>;
export function effectiveMode(state: StateMap, ref: { policy: PolicyId }): Effective<PolicyMode>;
export function effectiveMode(
  state: StateMap,
  ref: "global" | { stage: StageId; dims?: Partial<Record<DimKey, string>> } | { policy: PolicyId },
): Effective {
  const global = desiredMode(state, { type: "global" }).value;
  if (ref === "global") return { mode: global, desired: global, cappedBy: null };

  const desired =
    "stage" in ref
      ? desiredMode(state, { type: "stage", id: ref.stage }).value
      : desiredMode(state, { type: "policy", id: ref.policy }).value;

  let mode: Mode = desired;
  let cappedBy: CappedBy = null;
  if (global === "off" && rank(mode) > rank("off")) {
    mode = "off";
    cappedBy = "global";
  }
  if ("stage" in ref && ref.dims) {
    for (const dim of stageDef(ref.stage).dims ?? []) {
      const value = ref.dims[dim];
      if (value === undefined) continue;
      const override = overrideMode(state, ref.stage, dim, value).value;
      if (override !== null && rank(override) < rank(mode)) {
        mode = override;
        cappedBy = `${dim}=${value}`;
      }
    }
  }
  return { mode, desired, cappedBy };
}

/** Every stage's and policy's effective mode — handy for the "all off" view and tests. */
export function effectiveAll(state: StateMap): {
  global: GlobalMode;
  stages: Record<StageId, StageMode>;
  policies: Record<PolicyId, PolicyMode>;
} {
  const stagesOut = {} as Record<StageId, StageMode>;
  for (const id of STAGE_IDS) stagesOut[id] = effectiveMode(state, { stage: id }).mode;
  const policiesOut = {} as Record<PolicyId, PolicyMode>;
  for (const id of POLICY_IDS) policiesOut[id] = effectiveMode(state, { policy: id }).mode;
  return { global: effectiveMode(state, "global").mode, stages: stagesOut, policies: policiesOut };
}

/** The stored-or-default value of any target, as the canonical string the change log records. */
export function desiredValue(state: StateMap, target: Target): string | null {
  switch (target.kind) {
    case "mode":
      return desiredMode(state, target.entry).value;
    case "knob":
      return String(knobValue(state, target).value);
    case "dim":
      return overrideMode(state, target.stage, target.dim, target.value).value;
  }
}
