import { STAGE_IDS } from "@opusfinder/control";

import type { StatusView } from "../service";
import { card, empty, filterForm, filterSelect, periodFields, tabs } from "./components";
import { esc } from "./format";
import { layout } from "./layout";

/** Adding a Log tab is an entry in TABS and one logPage call. */

/** Paths predate the Log (they were separate pages), so old links still land. */
const TABS = [
  { id: "runs", path: "/runs", label: "Runs" },
  { id: "changes", path: "/activity", label: "Changes" },
  { id: "proposals", path: "/proposals", label: "Proposals" },
] as const;

export type LogTab = (typeof TABS)[number]["id"];

/** The tab bar. The stage and the period carry across tabs; a tab's own outcome filter doesn't. */
export function logTabs(current: LogTab, q: Pick<LogQuery, "stage" | "from" | "to">): string {
  const p = new URLSearchParams();
  if (q.stage) p.set("stage", q.stage);
  if (q.from) p.set("from", q.from);
  if (q.to) p.set("to", q.to);
  const qs = p.toString() ? `?${p.toString()}` : "";
  return tabs(
    TABS.map((t) => ({ href: `${t.path}${qs}`, label: t.label, current: t.id === current })),
  );
}

export interface LogQuery {
  stage: string;
  outcome?: string;
  from: string;
  to: string;
}

export function logPage(
  view: StatusView,
  o: {
    tab: LogTab;
    q: LogQuery;
    outcomes?: readonly string[];
    list: string;
    empty: { none: string; noMatch: string };
    more: boolean;
    lastId: number | undefined;
    noun: string;
  },
): string {
  const path = TABS.find((t) => t.id === o.tab)?.path ?? "/runs";
  const filters = filterForm(path, [
    filterSelect("stage", "Stage", STAGE_IDS, o.q.stage),
    ...(o.outcomes ? [filterSelect("outcome", "Outcome", o.outcomes, o.q.outcome ?? "")] : []),
    ...periodFields(o.q.from, o.q.to),
  ]);
  let older = "";
  if (o.more && o.lastId !== undefined) {
    const next = new URLSearchParams();
    if (o.q.stage) next.set("stage", o.q.stage);
    if (o.q.outcome) next.set("outcome", o.q.outcome);
    if (o.q.from) next.set("from", o.q.from);
    if (o.q.to) next.set("to", o.q.to);
    next.set("before", String(o.lastId));
    older = `<a href="${path}?${esc(next.toString())}">Older ${esc(o.noun)} →</a>`;
  }
  const filtered = Boolean(o.q.stage || o.q.outcome || o.q.from || o.q.to);
  return layout(view, {
    section: "log",
    tabs: logTabs(o.tab, o.q),
    flash: null,
    body: `${filters}${card({
      flush: true,
      body: o.list || empty(filtered ? o.empty.noMatch : o.empty.none),
      ...(older ? { foot: older } : {}),
    })}`,
  });
}
