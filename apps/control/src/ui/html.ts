import {
  INHERIT,
  isStageId,
  parseTarget,
  policyDef,
  stageDef,
  type PolicyId,
  type StageDef,
  type StageId,
  type ValueSource,
} from "@opusfinder/control";

import type { StatusView } from "../service";

/**
 * Shared pieces of the panel's server-rendered pages (§6 option d): the layout (header, section nav), the
 * stylesheet and small formatters. No framework, no script, no build step — every page renders from the
 * same reads the JSON API returns (`/v1/status`, `/v1/runs`, `/v1/changes`), so a page can't show something
 * the API doesn't. Every dynamic string goes through {@link esc}: reasons, notes and run details are written
 * by agents and runtimes, so they are untrusted text.
 */

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type SectionId = "approvals" | "stages" | "health" | "runs" | "cost" | "activity";

export interface Section {
  id: SectionId;
  path: string;
  title: string;
  /** One line on the home page's card. */
  blurb: string;
}

/** The panel's sections, in the order the home page and the nav show them ("what needs me" first). */
export const SECTIONS: readonly Section[] = [
  {
    id: "approvals",
    path: "/approvals",
    title: "Approvals",
    blurb: "Agent proposals waiting for your decision.",
  },
  {
    id: "stages",
    path: "/stages",
    title: "Stages",
    blurb: "What runs: modes, knobs, per-source switches and policies.",
  },
  {
    id: "health",
    path: "/health",
    title: "Health & alerts",
    blurb: "Which checks may page you, and their thresholds.",
  },
  {
    id: "runs",
    path: "/runs",
    title: "Runs",
    blurb: "Every recorded run: outcome, duration and work done.",
  },
  {
    id: "cost",
    path: "/cost",
    title: "Cost",
    blurb: "What each vendor charged, from their own invoices.",
  },
  {
    id: "activity",
    path: "/activity",
    title: "Activity",
    blurb: "Every change: who, when, from what to what, and why.",
  },
];

export const STYLE = `
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e3e6;--card:#f6f6f8;--on:#1a7f37;--shadow:#9a6700;--off:#6b6b70;--bad:#cf222e;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#111214;--fg:#e8e8ea;--muted:#9a9aa1;--line:#2c2d31;--card:#1a1b1e;--on:#3fb950;--shadow:#d29922;--off:#8b8b92;--bad:#f85149;--accent:#58a6ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
.wrap{max-width:960px;margin:0 auto;padding:0 16px}
header.top{border-bottom:1px solid var(--line);padding-top:10px}
.bar{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;justify-content:space-between;padding-bottom:10px}
.brand{font-weight:700;color:var(--fg);text-decoration:none}
nav.sections{display:flex;flex-wrap:wrap;gap:0 2px}
nav.sections a{padding:6px 10px;color:var(--muted);text-decoration:none;font-size:.92rem;border-bottom:2px solid transparent}
nav.sections a[aria-current=page]{color:var(--fg);border-bottom-color:var(--accent);font-weight:600}
main.wrap{padding-top:16px;padding-bottom:32px}
h1{font-size:1.35rem;margin:0 0 4px}
h2{font-size:1.05rem;margin:28px 0 8px;padding-top:12px;border-top:1px solid var(--line)}
h3{font-size:.95rem;margin:16px 0 4px}
p{margin:6px 0}
.muted{color:var(--muted);font-size:.88rem}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.92rem}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.03em}
code{font:.85rem ui-monospace,SFMono-Regular,Menlo,monospace}
.mode{display:inline-block;padding:1px 8px;border-radius:10px;font-size:.82rem;font-weight:600;border:1px solid currentColor}
.m-on,.m-enforce,.m-approved,.m-ok{color:var(--on)}.m-shadow,.m-stale,.m-expired,.m-partial{color:var(--shadow)}.m-off,.m-inherit,.m-withdrawn,.m-skipped{color:var(--off)}.m-bad,.m-rejected,.m-error{color:var(--bad)}
.warn{color:var(--shadow);font-weight:600}
.bad{color:var(--bad);font-weight:600}
.flash{padding:10px 12px;border-radius:8px;background:var(--card);border-left:4px solid var(--on)}
.note{padding:8px 12px;border-radius:8px;background:var(--card);border-left:4px solid var(--shadow);font-size:.9rem}
.note.alarm{border-left-color:var(--bad)}
.card{background:var(--card);border-radius:8px;padding:12px;margin:10px 0}
.card h3{margin-top:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;margin-top:12px}
a.tile{display:block;padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);text-decoration:none}
a.tile:hover,a.tile:focus-visible{border-color:var(--accent)}
a.tile h2{margin:0 0 4px;padding:0;border:0}
a.tile .status{margin:10px 0 0;font-weight:600}
ul.rows,ul.log{list-style:none;padding:0;margin:0}
ul.rows>li,ul.log>li{padding:10px 0;border-bottom:1px solid var(--line)}
dl.facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:8px 0}
dl.facts dt{color:var(--muted);font-size:.88rem}
dl.facts dd{margin:0}
details.change{margin-top:6px}
details.change>summary{cursor:pointer;color:var(--accent);font-size:.88rem;width:max-content}
details.change[open]>summary{margin-bottom:6px}
.form{display:grid;gap:8px;max-width:520px}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin:8px 0}
.filters label{min-width:150px}
label{display:grid;gap:3px;font-size:.88rem;color:var(--muted)}
input,select,button{font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);width:100%}
button{cursor:pointer;background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.filters button{width:auto}
button.reject{background:transparent;color:var(--bad);border-color:var(--bad)}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:12px 0}
.stat{display:grid;gap:2px;background:var(--card);border-radius:8px;padding:12px}
.stat .v{font-size:1.45rem;font-weight:700}
/* Phones: a wide table's rows stack into blocks (short cells side by side, the last one full width). */
@media (max-width:640px){table.stack thead{display:none}table.stack tr{display:block;padding:8px 0;border-bottom:1px solid var(--line)}table.stack td{display:inline-block;border:0;padding:2px 12px 2px 0}table.stack td:last-child{display:block}}
`;

export function mode(value: string | null | undefined): string {
  const v = value ?? INHERIT;
  return `<span class="mode m-${esc(v)}">${esc(v)}</span>`;
}

/** "on", or "on → runs as off (capped by global)" when something caps it. Stages, policies, checks. */
export function modeLine(s: {
  desired: string;
  effective: string;
  cappedBy: string | null;
  source: ValueSource;
}): string {
  if (s.effective === s.desired) return `${mode(s.desired)}${sourceNote(s.source)}`;
  const capped = s.cappedBy ? ` <span class="muted">(capped by ${esc(s.cappedBy)})</span>` : "";
  return `${mode(s.desired)}${sourceNote(s.source)} → runs as ${mode(s.effective)}${capped}`;
}

/**
 * Where a scheduled stage stands against its expected period: "next due in 20 min"; "late: due 20 min
 * ago" while still within its grace; "overdue" past it. Empty when there's nothing to say.
 */
export function dueText(s: { nextDueAt: string | null; overdue: boolean }, nowIso: string): string {
  if (!s.nextDueAt) return "";
  if (s.overdue)
    return `<span class="bad">overdue</span> <span class="muted">(was due ${esc(ago(s.nextDueAt, nowIso))})</span>`;
  if (Date.parse(s.nextDueAt) < Date.parse(nowIso))
    return `<span class="warn">late</span> <span class="muted">(due ${esc(ago(s.nextDueAt, nowIso))}, within its grace)</span>`;
  return `next due ${esc(ago(s.nextDueAt, nowIso))}`;
}

/** A GET filter's dropdown: "all" plus each value, the current one selected. */
export function filterSelect(
  name: string,
  label: string,
  values: readonly string[],
  current: string,
): string {
  return `<label>${esc(label)}<select name="${esc(name)}"><option value="">all</option>${values
    .map((v) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(v)}</option>`)
    .join("")}</select></label>`;
}

/** A stored value as the change log and proposals show it: a number (a knob) as code, a mode as a badge. */
export function value(v: string | null | undefined): string {
  return v !== null && v !== undefined && /^-?\d/.test(v) ? `<code>${esc(v)}</code>` : mode(v);
}

/** A run outcome (ok / partial / error / skipped) as a badge. */
export function outcome(value: string): string {
  return `<span class="mode m-${esc(value)}">${esc(value)}</span>`;
}

export function sourceNote(source: ValueSource): string {
  if (source === "default") return ` <span class="muted">(default)</span>`;
  if (source === "invalid") return ` <span class="muted">(unreadable value → failed closed)</span>`;
  return "";
}

/** ISO minus seconds/millis, in UTC: compact and unambiguous on a phone. */
export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  return `<span class="muted">${esc(iso.slice(0, 16).replace("T", " "))} UTC</span>`;
}

/** "12 min ago" / "in 40 min", from the page's own clock (view.generatedAt). */
export function ago(iso: string | null | undefined, nowIso: string): string {
  if (!iso) return "";
  const diff = Date.parse(nowIso) - Date.parse(iso);
  if (!Number.isFinite(diff)) return "";
  const mins = Math.round(Math.abs(diff) / 60_000);
  const span =
    mins < 1
      ? "under a minute"
      : mins < 90
        ? `${mins} min`
        : mins < 36 * 60
          ? `${Math.round(mins / 60)} h`
          : `${Math.round(mins / 1440)} d`;
  return diff >= 0 ? `${span} ago` : `in ${span}`;
}

/** A run's duration: "38 s", "4 min 10 s", "1 h 2 min". */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A period in minutes as the registry's `expect` uses it: "2 h", "7 d", "45 min". */
export function period(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

export function num(n: number): string {
  return n.toLocaleString("en-US");
}

export function trigger(t: StageDef["trigger"]): string {
  if ("cron" in t) return `cron <code>${esc(t.cron)}</code>`;
  if ("event" in t) return `event <code>${esc(t.event)}</code>`;
  return "run by hand";
}

/** How far the stage's runtime obeys the control plane, short (lists) and long (detail pages). */
export const GATE_SHORT: Record<StageDef["gate"], string> = {
  unwired: "not wired",
  shadow: "read in shadow",
  enforced: "enforced",
};

export const GATE_LONG: Record<StageDef["gate"], string> = {
  unwired:
    "Not wired yet: the runtime doesn't read this switch, so changing it here changes the record, not behaviour. Its env vars, code constants and vendor pauses still rule.",
  shadow:
    "Shadow: the runtime reads this switch at the start of each tick and logs what it would do, then runs exactly as before. Its env vars still rule.",
  enforced: "Enforced: the runtime obeys this switch on its next tick.",
};

/** What happens to a tick when the control plane can't be read, by how far the runtime is wired. */
export const GATE_UNREADABLE: Record<StageDef["gate"], string> = {
  unwired: "nothing changes: the runtime doesn't read it yet",
  shadow: "the runtime logs that it would skip, then runs anyway (not enforced yet)",
  enforced: "the stage skips its tick (fail closed)",
};

/** The health checks are the policies the alerts stage reads; the rest (close, stale_sweep) are lifecycle. */
export function isHealthCheck(id: PolicyId): boolean {
  return (policyDef(id).readBy as readonly string[]).includes("alerts");
}

export function stageHref(id: StageId): string {
  return `/stages/${id}`;
}

/** Where a target address is shown and changed in the panel (null when it no longer parses). */
export function targetHref(address: string): string | null {
  const t = parseTarget(address);
  if (!t.ok) return null;
  const entry = t.value.kind === "dim" ? null : t.value.entry;
  if (t.value.kind === "dim") return stageHref(t.value.stage);
  if (!entry || entry.type === "global") return "/stages";
  if (entry.type === "stage") return stageHref(entry.id);
  return isHealthCheck(entry.id) ? "/health" : `/stages#policy-${entry.id}`;
}

/** A target as code, linked to where it lives in the panel. */
export function targetLink(address: string): string {
  const href = targetHref(address);
  const code = `<code>${esc(address)}</code>`;
  return href ? `<a href="${esc(href)}">${code}</a>` : code;
}

export function stageLink(id: string): string {
  return `<a href="/stages/${esc(id)}"><code>${esc(id)}</code></a>`;
}

/** Label for a stage id, falling back to the id (a ledger row can name a stage the registry has dropped). */
export function stageLabel(id: string): string {
  return isStageId(id) ? stageDef(id).label : id;
}

const FLASH: Record<string, string> = {
  applied: "Change applied and logged.",
  noop: "Nothing to change — it already had that value.",
  approved: "Proposal approved and applied.",
  rejected: "Proposal rejected.",
  stale:
    "That proposal was stale — its target had moved since it was filed — so nothing was applied. It is listed under recently closed.",
  statement_added: "Statement added.",
  statement_counted: "Statement counted.",
  statement_excluded: "Statement excluded from the totals.",
};

export function isOwner(view: StatusView): boolean {
  return view.caller.role === "owner";
}

interface PageOpts {
  section: SectionId | "home";
  title: string;
  /** The `?done=` value; only the fixed messages above are ever shown (no reflected text). */
  flash: string | null;
  body: string;
}

export function layout(view: StatusView, page: PageOpts): string {
  const owner = isOwner(view);
  const open = view.openProposals.length;
  const nav =
    page.section === "home"
      ? ""
      : `<nav class="sections wrap" aria-label="Sections">${SECTIONS.map(
          (s) =>
            `<a href="${s.path}"${s.id === page.section ? ' aria-current="page"' : ""}>${esc(s.title)}${
              s.id === "approvals" && open > 0 ? ` (${open})` : ""
            }</a>`,
        ).join("")}</nav>`;
  const flash =
    page.flash && FLASH[page.flash]
      ? `<p class="flash" role="status">${esc(FLASH[page.flash])}</p>`
      : "";
  const masterOff =
    view.global.desired === "off"
      ? `<p class="note alarm"><strong>The master switch is off:</strong> every stage and policy is capped at off. <a href="/stages">Stages</a></p>`
      : "";
  const heading = page.section === "home" ? "" : `<h1>${esc(page.title)}</h1>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.section === "home" ? "" : `${esc(page.title)} · `}opusfinder control</title><style>${STYLE}</style></head>
<body><header class="top"><div class="wrap bar"><a class="brand" href="/">opusfinder control</a>
<span class="muted">master switch ${mode(view.global.desired)} · <code>${esc(view.caller.role)}:${esc(view.caller.name)}</code> · ${when(view.generatedAt)}${
    owner ? "" : " · read-only here (agents change things through the API or <code>pnpm ctl</code>)"
  }</span></div>${nav}</header>
<main class="wrap">${heading}${flash}${masterOff}
${page.body}</main></body></html>`;
}

export function renderError(status: number, code: string, message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>opusfinder control: ${esc(status)}</title><style>${STYLE}</style></head>
<body><main class="wrap"><h1>${esc(status)} — ${esc(code)}</h1><p>${esc(message)}</p><p><a href="/">Back to the control panel</a></p></main></body></html>`;
}
