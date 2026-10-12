import type { PolicyView } from "@opusfinder/control";

import type { RunView, StatusView } from "../service";
import type { ChangeRow } from "../store";
import { changeRows } from "./changes";
import { card, controlRow, empty, facts, item, rowList, table } from "./components";
import { knobRow, modeControl, sliceControl } from "./forms";
import { ago, duration, esc, period } from "./format";
import { isOwner, layout } from "./layout";
import { runTable } from "./runs";
import {
  dueText,
  isHealthCheck,
  mode,
  modeLine,
  outcome,
  sourceNote,
  stageHref,
  targetHref,
  trigger,
  wiring,
} from "./vocab";

type StageRow = StatusView["stages"][number];

function lastRunShort(s: StageRow, nowIso: string): string {
  if (!s.lastRun) return `<span class="muted">never</span>`;
  return `${outcome(s.lastRun.outcome)} <span class="muted">${esc(ago(s.lastRun.started_at, nowIso))}</span>`;
}

function nextDueText(s: StageRow, nowIso: string): string {
  const due = dueText(s, nowIso);
  if (due) return due;
  if (s.effective === "off") return `<span class="muted">off</span>`;
  return `<span class="muted">${"cron" in s.trigger ? "—" : "event" in s.trigger ? "on event" : "run by hand"}</span>`;
}

function readers(p: PolicyView): string {
  return p.readBy.map((id) => `<a href="${stageHref(id)}">${esc(id)}</a>`).join(", ");
}

function policyRow(p: PolicyView, edit: string | null): string {
  return controlRow({
    id: `policy-${p.id}`,
    name: p.label,
    hover: p.id,
    lines: [`read by ${readers(p)}`],
    value: modeLine(p, "policy", edit && modeControl(p, "policy", edit, p.label)),
    settings: p.knobs.map((k) => knobRow(k, edit)),
  });
}

export function renderStages(view: StatusView, flash: string | null): string {
  const edit = isOwner(view) ? "/stages" : null;
  const now = view.generatedAt;
  const parts: string[] = [];

  parts.push(
    card({
      flush: true,
      body: rowList([
        controlRow({
          id: "global",
          name: "Master switch",
          value: `${
            edit
              ? modeControl(view.global, "global", edit, "Master switch")
              : mode(view.global.desired, "global")
          }${sourceNote(view.global.source)}`,
        }),
      ]),
    }),
  );

  parts.push(
    card({
      title: "Stages",
      flush: true,
      body: table(
        ["Stage", "Mode", "Wiring", "Last run", "Next due"],
        view.stages.map((s) => [
          `<a href="${stageHref(s.id)}" title="${esc(s.id)}"><strong>${esc(s.label)}</strong></a>`,
          `${modeLine(s, "stage")}${
            s.overrides.length > 0
              ? ` <span class="muted">+${s.overrides.length} override${s.overrides.length === 1 ? "" : "s"}</span>`
              : ""
          }`,
          wiring(s.gate),
          lastRunShort(s, now),
          nextDueText(s, now),
        ]),
        { labelled: true },
      ),
    }),
  );

  const lifecycle = view.policies.filter((p) => !isHealthCheck(p.id));
  parts.push(
    card({
      id: "policies",
      title: "Policies",
      flush: true,
      body: rowList(lifecycle.map((p) => policyRow(p, edit))),
    }),
  );

  return layout(view, { section: "stages", flash, body: parts.join("\n") });
}

function budgetText(s: StageRow): string {
  const target = s.budget?.targetUsdPerMonth;
  return target !== undefined ? `$${esc(target)}/mo target` : "";
}

function stageFacts(s: StageRow, nowIso: string): string {
  return facts([
    ["Wiring", wiring(s.gate)],
    [
      "Last run",
      s.lastRun
        ? `${lastRunShort(s, nowIso)}${
            s.lastRun.duration_ms !== null
              ? ` <span class="muted">· took ${esc(duration(s.lastRun.duration_ms))}</span>`
              : ""
          }`
        : `<span class="muted">none recorded</span>`,
    ],
    ["Next due", nextDueText(s, nowIso)],
    [
      "Schedule",
      s.expect
        ? `every ${esc(period(s.expect.everyMin))} <span class="muted">· ${esc(
            period(s.expect.graceMin),
          )} grace · ${trigger(s.trigger)}</span>`
        : trigger(s.trigger),
    ],
    [
      "Runs on",
      `<code>${esc(s.runtime)}</code>${s.platformId ? ` <span class="muted">· <code>${esc(s.platformId)}</code></span>` : ""}`,
    ],
    ["Logs only means", s.shadowMeans ? esc(s.shadowMeans) : ""],
    ["Watchdog", s.heartbeat ? `<code>${esc(s.heartbeat)}</code>` : ""],
    ["Budget", budgetText(s)],
    ["Agents", s.agent === "approval" ? "need your approval for any change" : ""],
  ]);
}

function dimCard(s: StageRow, dim: string, values: readonly string[], edit: string | null): string {
  const set = new Map(s.overrides.filter((o) => o.dim === dim).map((o) => [o.value, o]));
  return card({
    title: `Per ${dim}`,
    flush: true,
    body: rowList(
      values.map((v) => {
        const o = set.get(v);
        const target = `${s.id}@${dim}=${v}`;
        return controlRow({
          name: v,
          value: `${
            edit
              ? sliceControl(s, { target, label: v, override: o?.override ?? null }, edit)
              : mode(o?.override, "stage")
          }${o ? sourceNote(o.source) : ""}${
            o && o.effective !== o.override ? ` → ${mode(o.effective, "stage")}` : ""
          }`,
        });
      }),
    ),
  });
}

function relatedRows(view: StatusView, s: StageRow): string[] {
  return [
    ...view.policies
      .filter((p) => (p.readBy as readonly string[]).includes(s.id))
      .map((p) =>
        item({
          title: `<a href="${esc(targetHref(p.id) ?? "/stages")}" title="${esc(p.id)}">${esc(p.label)}</a>`,
          lines: [isHealthCheck(p.id) ? "health check it runs" : "policy it reads"],
          end: mode(p.effective, isHealthCheck(p.id) ? "check" : "policy"),
        }),
      ),
    ...view.policies
      .filter((p) => p.watches === s.id)
      .map((p) =>
        item({
          title: `<a href="/health" title="${esc(p.id)}">${esc(p.label)}</a>`,
          lines: ["health check watching it"],
          end: mode(p.effective, "check"),
        }),
      ),
  ];
}

export function renderStage(
  view: StatusView,
  s: StageRow,
  runs: readonly RunView[],
  changes: readonly ChangeRow[],
  flash: string | null,
): string {
  const edit = isOwner(view) ? stageHref(s.id) : null;
  const now = view.generatedAt;
  const parts: string[] = [];

  parts.push(
    card({
      title: "Status",
      aside: `<code class="muted">${esc(s.id)}</code>`,
      flush: true,
      body: `${rowList([
        controlRow({
          name: "Mode",
          value: modeLine(s, "stage", edit && modeControl(s, "stage", edit, s.label)),
        }),
      ])}<div class="card-b">${stageFacts(s, now)}</div>`,
    }),
  );

  if (s.knobs.length > 0)
    parts.push(
      card({
        title: "Settings",
        flush: true,
        body: rowList(s.knobs.map((k) => knobRow(k, edit))),
      }),
    );

  for (const [dim, values] of Object.entries(s.dims))
    if (values) parts.push(dimCard(s, dim, values, edit));

  const related = relatedRows(view, s);
  if (related.length > 0)
    parts.push(card({ title: "Related switches", flush: true, body: rowList(related) }));

  parts.push(
    card({
      title: "Recent runs",
      flush: true,
      body: runs.length === 0 ? empty("No runs recorded.") : runTable(runs, now, false),
      foot: `<a href="/runs?stage=${esc(s.id)}">All ${esc(s.id)} runs →</a>`,
    }),
  );
  parts.push(
    card({
      title: "Recent changes",
      flush: true,
      body: rowList(changeRows(changes, view), "No changes recorded."),
      foot: `<a href="/activity?stage=${esc(s.id)}">All ${esc(s.id)} changes →</a>`,
    }),
  );

  return layout(view, {
    section: "stages",
    title: s.label,
    flash,
    body: parts.join("\n"),
  });
}
