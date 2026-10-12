import type { StatusView } from "../service";
import { icon } from "./components";
import { esc, stamp } from "./format";
import { STYLE } from "./style";

/** No script: every page renders from the same reads the JSON API returns, so a page can't show what the API doesn't. */

export type SectionId = "overview" | "approvals" | "stages" | "health" | "cost" | "log";

export interface Section {
  id: SectionId;
  path: string;
  title: string;
  /** Feather icon paths (MIT). */
  icon: string;
}

export const SECTIONS: readonly Section[] = [
  {
    id: "overview",
    path: "/",
    title: "Overview",
    icon: `<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>`,
  },
  {
    id: "approvals",
    path: "/approvals",
    title: "Approvals",
    icon: `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>`,
  },
  {
    id: "stages",
    path: "/stages",
    title: "Stages",
    icon: `<rect x="1" y="5" width="22" height="14" rx="7" ry="7"/><circle cx="16" cy="12" r="3"/>`,
  },
  {
    id: "health",
    path: "/health",
    title: "Health & alerts",
    icon: `<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>`,
  },
  {
    id: "cost",
    path: "/cost",
    title: "Cost",
    icon: `<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>`,
  },
  {
    id: "log",
    path: "/runs",
    title: "Log",
    icon: `<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>`,
  },
];

export function section(id: SectionId): Section {
  return SECTIONS.find((s) => s.id === id) as Section;
}

const FLASH: Record<string, string> = {
  applied: "Change applied.",
  noop: "Nothing to change — it already had that value.",
  approved: "Proposal approved and applied.",
  rejected: "Proposal rejected.",
  stale: "That proposal was stale, so nothing was applied.",
  closed: "That proposal was already closed.",
  statement_added: "Charge added.",
  statement_duplicate: "Matches a charge already counted, so it's under Not counted.",
  statement_counted: "Charge counted.",
  statement_excluded: "Charge left out of the totals.",
};

export function isOwner(view: StatusView): boolean {
  return view.caller.role === "owner";
}

interface PageOpts {
  section: SectionId;
  title?: string;
  tabs?: string;
  /** The `?done=` value; only the fixed messages above are ever shown (no reflected text). */
  flash: string | null;
  body: string;
}

export function layout(view: StatusView, page: PageOpts): string {
  const owner = isOwner(view);
  const open = view.openProposals.length;
  const sec = section(page.section);
  const title = page.title ?? sec.title;
  const nav = SECTIONS.map(
    (s) =>
      `<a href="${s.path}"${s.id === page.section ? ' aria-current="page"' : ""}>${icon(s.icon)}${esc(s.title)}${
        s.id === "approvals" && open > 0 ? `<span class="count">${open}</span>` : ""
      }</a>`,
  ).join("");
  const flash =
    page.flash && FLASH[page.flash]
      ? `<p class="banner ok" role="status">${esc(FLASH[page.flash])}</p>`
      : "";
  const masterOff =
    view.global.desired === "off"
      ? `<p class="banner bad"><strong>The master switch is off.</strong> <a href="/stages">Stages</a></p>`
      : "";
  const g = view.generatedAt;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.section === "overview" ? "" : `${esc(title)} · `}opusfinder control</title><style>${STYLE}</style></head>
<body><div class="app"><aside class="side"><a class="brand" href="/"><span class="mark"></span>opusfinder <span>control</span></a>
<nav class="nav" aria-label="Sections">${nav}</nav>
<div class="who"><span class="id" title="${esc(`${view.caller.role}:${view.caller.name}`)}">${esc(
    view.caller.role,
  )} · ${esc(view.caller.name)}</span><span>as of ${esc(stamp(g))} UTC</span>${
    owner ? "" : `<span class="ro">You're read-only here.</span>`
  }</div></aside>
<main class="main"><header class="head"><h1>${esc(title)}</h1></header>${page.tabs ?? ""}${flash}${masterOff}
${page.body}</main></div></body></html>`;
}

export function renderError(status: number, code: string, message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>opusfinder control: ${esc(status)}</title><style>${STYLE}</style></head>
<body><main class="main"><header class="head"><h1>${esc(status)} — ${esc(code)}</h1><p class="lede">${esc(
    message,
  )}</p></header><p><a href="/">Back to the control panel</a></p></main></body></html>`;
}
