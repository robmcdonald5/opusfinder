import { RUN_OUTCOMES, STAGE_IDS, type RunOutcome } from "@opusfinder/control";

import type { RunView, StatusView } from "../service";
import {
  ago,
  dueText,
  duration,
  esc,
  filterSelect,
  layout,
  mode,
  num,
  outcome,
  stageLabel,
  stageLink,
  when,
} from "./html";

/** Runs: the run ledger (one row per recorded run), newest first, filterable and paged. */

function units(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "";
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return "";
  return `<details><summary class="muted">units</summary>${entries
    .map(
      ([k, v]) => `<code>${esc(k)}</code> ${typeof v === "number" ? esc(num(v)) : esc(String(v))}`,
    )
    .join("<br>")}</details>`;
}

/** The run table, shared with the stage pages. */
export function runTable(runs: readonly RunView[], nowIso: string, showStage: boolean): string {
  if (runs.length === 0) return `<p class="muted">No runs recorded.</p>`;
  return `<div class="scroll"><table class="stack"><thead><tr><th>Started</th>${
    showStage ? "<th>Stage</th>" : ""
  }<th>Outcome</th><th>Took</th><th>Detail</th></tr></thead><tbody>${runs
    .map(
      (r) =>
        `<tr><td>${when(r.started_at)}<br><span class="muted">${esc(ago(r.started_at, nowIso))}</span></td>${
          showStage ? `<td>${stageLink(r.stage)}</td>` : ""
        }<td>${outcome(r.outcome)}<br><span class="muted">gate ${
          r.gate_mode ? mode(r.gate_mode) : "unread"
        }</span></td><td>${esc(duration(r.duration_ms))}</td><td>${esc(r.detail ?? "")}${units(
          r.units,
        )}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function counts(byOutcome: Partial<Record<RunOutcome, number>> | undefined): string {
  if (!byOutcome) return `<span class="muted">none</span>`;
  return RUN_OUTCOMES.filter((o) => (byOutcome[o] ?? 0) > 0)
    .map((o) => `${byOutcome[o]} ${outcome(o)}`)
    .join(" ");
}

export interface RunsQuery {
  stage: string;
  outcome: string;
}

export function renderRuns(
  view: StatusView,
  list: { runs: RunView[]; more: boolean },
  q: RunsQuery,
): string {
  const parts: string[] = [];

  // ---- per stage: last run, next due, last 24 h ----
  const recorded = view.stages.filter(
    (s) => s.lastRun !== null || view.recentRuns.byStage[s.id] !== undefined,
  );
  const silent = view.stages.filter((s) => !recorded.includes(s));
  parts.push(`<h2>By stage</h2>`);
  if (recorded.length > 0)
    parts.push(
      `<div class="scroll"><table class="stack"><thead><tr><th>Stage</th><th>Last run</th><th>Next due</th><th>Last 24 h</th></tr></thead><tbody>${recorded
        .map(
          (s) =>
            `<tr><td>${esc(s.label)}<br>${stageLink(s.id)}</td><td>${
              s.lastRun
                ? `${outcome(s.lastRun.outcome)} ${when(s.lastRun.started_at)}<br><span class="muted">${esc(
                    ago(s.lastRun.started_at, view.generatedAt),
                  )}${s.lastRun.duration_ms !== null ? `, took ${esc(duration(s.lastRun.duration_ms))}` : ""}</span>`
                : `<span class="muted">none</span>`
            }</td><td>${
              dueText(s, view.generatedAt) ||
              (s.effective === "off" ? `<span class="muted">off</span>` : "")
            }</td><td>${counts(view.recentRuns.byStage[s.id])}</td></tr>`,
        )
        .join("")}</tbody></table></div>`,
    );
  if (silent.length > 0)
    parts.push(
      `<p class="muted">No runs recorded for ${silent
        .map((s) => esc(s.id))
        .join(
          ", ",
        )}: their runtimes don't write to the ledger yet, or they haven't run since it started.</p>`,
    );

  // ---- the ledger ----
  parts.push(`<h2>All runs</h2>
<form class="filters" method="get" action="/runs">${filterSelect("stage", "Stage", STAGE_IDS, q.stage)}${filterSelect(
    "outcome",
    "Outcome",
    RUN_OUTCOMES,
    q.outcome,
  )}<button type="submit">Show</button></form>`);
  parts.push(runTable(list.runs, view.generatedAt, true));
  const last = list.runs[list.runs.length - 1];
  if (list.more && last) {
    const next = new URLSearchParams();
    if (q.stage) next.set("stage", q.stage);
    if (q.outcome) next.set("outcome", q.outcome);
    next.set("before", String(last.id));
    parts.push(`<p><a href="/runs?${esc(next.toString())}">Older runs →</a></p>`);
  }

  const title = q.stage ? `Runs: ${stageLabel(q.stage)}` : "Runs";
  return layout(view, { section: "runs", title, flash: null, body: parts.join("\n") });
}
