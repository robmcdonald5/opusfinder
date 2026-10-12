import {
  INHERIT,
  isStageId,
  knobDef,
  parseTarget,
  policyDef,
  stageDef,
  type PolicyId,
  type StageDef,
  type StageId,
  type ValueSource,
} from "@opusfinder/control";

import { ago, esc } from "./format";

export type ModeKind = "global" | "stage" | "policy" | "check";

/** The middle mode is stored as `shadow` (and a check's top as `enforce`); the panel says what each does. Stored values stay as they are for the API, `pnpm ctl` and agents. */
const MODE_LABELS: Record<ModeKind, Readonly<Record<string, string>>> = {
  global: {},
  stage: { shadow: "logs only" },
  policy: { shadow: "logs only", enforce: "on" },
  check: { shadow: "logs only", enforce: "emails you" },
};

export function modeLabel(value: string, kind: ModeKind): string {
  return MODE_LABELS[kind][value] ?? (value === INHERIT ? "follows stage" : value);
}

function targetKind(address: string): ModeKind {
  const t = parseTarget(address);
  if (!t.ok || t.value.kind === "dim") return "stage";
  const e = t.value.entry;
  if (e.type === "global") return "global";
  if (e.type === "stage") return "stage";
  return isHealthCheck(e.id) ? "check" : "policy";
}

export function mode(value: string | null | undefined, kind?: ModeKind): string {
  const v = value ?? INHERIT;
  const label = kind ? modeLabel(v, kind) : v === INHERIT ? "follows stage" : v;
  return `<span class="mode m-${esc(v)}">${esc(label)}</span>`;
}

/** `control`, when given, stands in for the desired mode's indicator (the owner's dropdown). */
export function modeLine(
  s: {
    desired: string;
    effective: string;
    cappedBy: string | null;
    source: ValueSource;
  },
  kind: ModeKind,
  control?: string | false | null,
): string {
  const desired = `${control || mode(s.desired, kind)}${sourceNote(s.source)}`;
  if (s.effective === s.desired) return desired;
  const capped = s.cappedBy
    ? ` <span class="muted">(capped by ${s.cappedBy === "global" ? "the master switch" : esc(s.cappedBy)})</span>`
    : "";
  return `${desired} → ${mode(s.effective, kind)}${capped}`;
}

export function dueText(s: { nextDueAt: string | null; overdue: boolean }, nowIso: string): string {
  if (!s.nextDueAt) return "";
  const since = esc(ago(s.nextDueAt, nowIso));
  if (s.overdue)
    return `<span class="bad">overdue</span> <span class="muted">· due ${since}</span>`;
  if (Date.parse(s.nextDueAt) < Date.parse(nowIso))
    return `<span class="warn">late</span> <span class="muted" title="still within its grace">· due ${since}</span>`;
  return since;
}

export function value(v: string | null | undefined, target: string): string {
  return v !== null && v !== undefined && /^-?\d/.test(v)
    ? `<code>${esc(v)}</code>`
    : mode(v, targetKind(target));
}

export function outcome(value: string): string {
  return `<span class="mode m-${esc(value)}">${esc(value)}</span>`;
}

export function sourceNote(source: ValueSource): string {
  if (source === "invalid")
    return ` <span class="muted">(unreadable, so the safe value is used)</span>`;
  if (source === "clamped")
    return ` <span class="muted">(out of range, so the nearest allowed value is used)</span>`;
  return "";
}

export function who(
  label: string | null | undefined,
  viewer: { role: string; name: string },
): string {
  const raw = label ?? "";
  const i = raw.indexOf(":");
  const role = i < 0 ? raw : raw.slice(0, i);
  const name = i < 0 ? "" : raw.slice(i + 1);
  const short =
    role === viewer.role && name === viewer.name
      ? "you"
      : role === "owner"
        ? "owner"
        : role === "agent"
          ? `agent ${name}`
          : role === "runtime"
            ? name.replace(/^[a-z]+:/, "")
            : role === "seed"
              ? "migration seed"
              : raw;
  return `<span title="${esc(raw)}">${esc(short || raw)}</span>`;
}

export function trigger(t: StageDef["trigger"]): string {
  if ("cron" in t) return `cron <code>${esc(t.cron)}</code>`;
  if ("event" in t) return `event <code>${esc(t.event)}</code>`;
  return "run by hand";
}

/** A stage's wiring (the registry's `gate`). Never worded "shadow": that is only ever a mode. */
const GATE_SHORT: Record<StageDef["gate"], string> = {
  unwired: "not wired",
  shadow: "logs only",
  enforced: "wired",
};

const GATE_LONG: Record<StageDef["gate"], string> = {
  unwired:
    "Not wired: the runtime ignores this switch, so a change here is recorded but its env vars still rule.",
  shadow:
    "Logs only: the runtime reads this switch and logs what it would do, but its env vars still rule.",
  enforced:
    "Wired: the runtime obeys this switch, and skips its tick when the switch can't be read.",
};

/** The same dot-and-word indicator as a mode, the full sentence on hover. */
export function wiring(gate: StageDef["gate"]): string {
  return `<span class="mode w-${esc(gate)}" title="${esc(GATE_LONG[gate])}">${esc(GATE_SHORT[gate])}</span>`;
}

/** Health checks are the policies the alerts stage reads; the rest (close, stale_sweep) are lifecycle. */
export function isHealthCheck(id: PolicyId): boolean {
  return (policyDef(id).readBy as readonly string[]).includes("alerts");
}

export function stageHref(id: StageId): string {
  return `/stages/${id}`;
}

export function targetHref(address: string): string | null {
  const t = parseTarget(address);
  if (!t.ok) return null;
  const entry = t.value.kind === "dim" ? null : t.value.entry;
  if (t.value.kind === "dim") return stageHref(t.value.stage);
  if (!entry || entry.type === "global") return "/stages";
  if (entry.type === "stage") return stageHref(entry.id);
  return isHealthCheck(entry.id) ? "/health" : `/stages#policy-${entry.id}`;
}

/** A stage's knob reads "ingest › Boards per tick"; a policy's knob by its own label (the health thresholds name themselves). */
function targetName(address: string): string {
  const t = parseTarget(address);
  if (!t.ok) return address;
  const v = t.value;
  if (v.kind === "dim") return `${v.stage} › ${v.value}`;
  if (v.kind === "knob")
    return v.entry.type === "stage" ? `${v.entry.id} › ${knobDef(v).label}` : knobDef(v).label;
  if (v.entry.type === "global") return "Master switch";
  return v.entry.type === "stage" ? stageDef(v.entry.id).label : policyDef(v.entry.id).label;
}

export function targetLink(address: string): string {
  const href = targetHref(address);
  const name = esc(targetName(address));
  return href
    ? `<a href="${esc(href)}" title="${esc(address)}">${name}</a>`
    : `<span title="${esc(address)}">${name}</span>`;
}

export function stageLink(id: string): string {
  return `<a href="/stages/${esc(id)}" title="${esc(stageLabel(id))}">${esc(id)}</a>`;
}

/** Falls back to the id: a ledger row can name a stage the registry has dropped. */
export function stageLabel(id: string): string {
  return isStageId(id) ? stageDef(id).label : id;
}

export function changeLine(target: string, from: string | null, to: string | null): string {
  return `${targetLink(target)} ${value(from, target)} → ${value(to, target)}`;
}
