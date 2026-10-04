// Target addresses — the one string form every surface uses for "the thing being changed": the D1 `state`
// key, the change_log/proposal `target` column, the API's `target` field, the page's form values and
// `pnpm ctl set <target> <value>`. One parser, so an address means the same thing everywhere.
//
//   global                         the master switch's mode
//   <stage> | <policy>             that entry's mode            e.g. ingest, close, health.board_fail_ratio
//   <entry>.<knob>                 a knob's value               e.g. ingest.boardsPerTick, health.board_fail_ratio.threshold
//   <stage>@<dim>=<value>          a narrowing override         e.g. ingest@source=smartrecruiters
//
// Policy ids may themselves contain a dot (health.*), so an exact entry match is tried first and a knob
// is split at the LAST dot. `@` and `=` never appear in ids (registry.test.ts pins that), and both are
// shell-safe unquoted in bash and zsh.
import {
  DIMENSIONS,
  globalSwitch,
  isPolicyId,
  isStageId,
  policyDef,
  stageDef,
  POLICY_IDS,
  STAGE_IDS,
  type DimKey,
  type Knob,
  type Mode,
  type PolicyId,
  type StageId,
} from "./registry";

export type EntryRef =
  | { type: "global" }
  | { type: "stage"; id: StageId }
  | { type: "policy"; id: PolicyId };

export type Target =
  | { kind: "mode"; entry: EntryRef }
  | { kind: "knob"; entry: Exclude<EntryRef, { type: "global" }>; knob: string }
  | { kind: "dim"; stage: StageId; dim: DimKey; value: string };

/** The value a dimension override is cleared with ("no override": inherit the stage's mode). */
export const INHERIT = "inherit";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function entryRef(id: string): EntryRef | null {
  if (id === "global") return { type: "global" };
  if (isStageId(id)) return { type: "stage", id };
  if (isPolicyId(id)) return { type: "policy", id };
  return null;
}

export function entryId(entry: EntryRef): string {
  return entry.type === "global" ? "global" : entry.id;
}

/** The settable modes of an entry, safest first. */
export function entryModes(entry: EntryRef): readonly Mode[] {
  if (entry.type === "global") return globalSwitch.modes;
  return entry.type === "stage" ? stageDef(entry.id).modes : policyDef(entry.id).modes;
}

export function entryKnobs(entry: EntryRef): Readonly<Record<string, Knob>> {
  if (entry.type === "global") return {};
  return (entry.type === "stage" ? stageDef(entry.id).knobs : policyDef(entry.id).knobs) ?? {};
}

export function knobDef(target: Extract<Target, { kind: "knob" }>): Knob {
  const knob = entryKnobs(target.entry)[target.knob];
  // parseTarget only builds knob targets for declared knobs; reaching this is a programming error.
  if (!knob) throw new Error(`unknown knob ${formatTarget(target)}`);
  return knob;
}

export function parseTarget(address: string): ParseResult<Target> {
  const addr = address.trim();
  if (addr.length === 0 || addr.length > 128)
    return { ok: false, error: "target must be 1-128 chars" };

  const at = addr.indexOf("@");
  if (at !== -1) {
    const stageId = addr.slice(0, at);
    const rest = addr.slice(at + 1);
    const eq = rest.indexOf("=");
    if (!isStageId(stageId)) return { ok: false, error: `unknown stage "${stageId}"` };
    if (eq === -1) return { ok: false, error: `override must look like ${stageId}@<dim>=<value>` };
    const dim = rest.slice(0, eq);
    const value = rest.slice(eq + 1);
    const dims: readonly string[] = stageDef(stageId).dims ?? [];
    if (!dims.includes(dim)) {
      return {
        ok: false,
        error: `stage "${stageId}" has no dimension "${dim}" (has: ${dims.join(", ") || "none"})`,
      };
    }
    const values: readonly string[] = DIMENSIONS[dim as DimKey];
    if (!values.includes(value)) {
      return { ok: false, error: `unknown ${dim} "${value}" (known: ${values.join(", ")})` };
    }
    return { ok: true, value: { kind: "dim", stage: stageId, dim: dim as DimKey, value } };
  }

  const whole = entryRef(addr);
  if (whole) return { ok: true, value: { kind: "mode", entry: whole } };

  const dot = addr.lastIndexOf(".");
  if (dot > 0) {
    const entry = entryRef(addr.slice(0, dot));
    const knob = addr.slice(dot + 1);
    if (entry && entry.type !== "global") {
      if (Object.hasOwn(entryKnobs(entry), knob)) {
        return { ok: true, value: { kind: "knob", entry, knob } };
      }
      const known = Object.keys(entryKnobs(entry));
      return {
        ok: false,
        error: `"${entry.id}" has no knob "${knob}" (has: ${known.join(", ") || "none"})`,
      };
    }
  }
  return { ok: false, error: `unknown target "${addr}"` };
}

export function formatTarget(target: Target): string {
  switch (target.kind) {
    case "mode":
      return entryId(target.entry);
    case "knob":
      return `${target.entry.id}.${target.knob}`;
    case "dim":
      return `${target.stage}@${target.dim}=${target.value}`;
  }
}

// Plain decimal only: no exponent, hex, whitespace, "Infinity" or a leading "+". A stored knob value is
// always this canonical form, so the change log reads the same as the input.
const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/**
 * Validate + canonicalize a proposed value for a target. Returns the string stored in `state.value`
 * (null = clear a dimension override). Out-of-range or wrong-kind values are REJECTED here, at the edge —
 * resolve.ts separately fails closed on anything invalid that reaches the store some other way.
 */
export function parseValue(target: Target, raw: string): ParseResult<string | null> {
  const value = raw.trim();
  switch (target.kind) {
    case "mode": {
      const modes = entryModes(target.entry);
      if (!(modes as readonly string[]).includes(value)) {
        return {
          ok: false,
          error: `${formatTarget(target)} takes one of: ${modes.join(", ")} (got "${value}")`,
        };
      }
      return { ok: true, value };
    }
    case "dim": {
      if (value === INHERIT) return { ok: true, value: null };
      const modes = stageDef(target.stage).modes;
      if (!(modes as readonly string[]).includes(value)) {
        return {
          ok: false,
          error: `${formatTarget(target)} takes one of: ${[...modes, INHERIT].join(", ")} (got "${value}")`,
        };
      }
      return { ok: true, value };
    }
    case "knob": {
      const knob = knobDef(target);
      if (!DECIMAL.test(value)) {
        return {
          ok: false,
          error: `${formatTarget(target)} takes a plain number (got "${value}")`,
        };
      }
      const n = Number(value);
      if (knob.int && !Number.isInteger(n)) {
        return {
          ok: false,
          error: `${formatTarget(target)} takes a whole number (got "${value}")`,
        };
      }
      if (n < knob.min || n > knob.max) {
        return {
          ok: false,
          error: `${formatTarget(target)} must be between ${knob.min} and ${knob.max} (got ${n})`,
        };
      }
      return { ok: true, value: String(n) };
    }
  }
}

/** Every settable target, in registry order: global, each stage (mode, knobs, overrides), each policy. */
export function allTargets(): Target[] {
  const out: Target[] = [{ kind: "mode", entry: { type: "global" } }];
  for (const id of STAGE_IDS) {
    const entry: EntryRef = { type: "stage", id };
    out.push({ kind: "mode", entry });
    for (const knob of Object.keys(entryKnobs(entry))) out.push({ kind: "knob", entry, knob });
    for (const dim of stageDef(id).dims ?? []) {
      for (const value of DIMENSIONS[dim]) out.push({ kind: "dim", stage: id, dim, value });
    }
  }
  for (const id of POLICY_IDS) {
    const entry: EntryRef = { type: "policy", id };
    out.push({ kind: "mode", entry });
    for (const knob of Object.keys(entryKnobs(entry))) out.push({ kind: "knob", entry, knob });
  }
  return out;
}

/** Collapse runs of whitespace/control characters and trim — reasons are one-line audit text. */
export const REASON_MAX = 300;
export function normalizeReason(raw: unknown): ParseResult<string> {
  if (typeof raw !== "string") return { ok: false, error: "reason is required" };
  // eslint-disable-next-line no-control-regex -- deliberately folding control characters into spaces
  const reason = raw.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  if (reason.length === 0) return { ok: false, error: "reason is required" };
  if (reason.length > REASON_MAX) {
    return { ok: false, error: `reason must be at most ${REASON_MAX} characters` };
  }
  return { ok: true, value: reason };
}
