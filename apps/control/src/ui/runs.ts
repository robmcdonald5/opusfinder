import { RUN_OUTCOMES } from "@opusfinder/control";

import type { RunView, StatusView } from "../service";
import { clip, table } from "./components";
import { duration, esc, ts } from "./format";
import { logPage, type LogQuery } from "./log";
import { modeLabel, outcome, stageLink } from "./vocab";

/** Only when the switch said something other than on: that the run went ahead anyway is what logs-only wiring surfaces. */
function gateNote(r: RunView): string {
  if (r.gate_mode === "on") return "";
  return ` <span class="warn" title="what this stage's switch said when the run started">${
    r.gate_mode ? `switch was ${esc(modeLabel(r.gate_mode, "stage"))}` : "switch unreadable"
  }</span>`;
}

export function runTable(runs: readonly RunView[], nowIso: string, showStage: boolean): string {
  return table(
    ["Started", ...(showStage ? ["Stage"] : []), "Outcome", "Took", "Detail"],
    runs.map((r) => [
      ts(r.started_at, nowIso),
      ...(showStage ? [stageLink(r.stage)] : []),
      `${outcome(r.outcome)}${gateNote(r)}`,
      esc(duration(r.duration_ms)),
      clip(r.detail),
    ]),
    { fill: showStage ? 4 : 3, rowClass: (i) => (runs[i]?.outcome === "error" ? "err" : "") },
  );
}

export function renderRuns(
  view: StatusView,
  list: { runs: RunView[]; more: boolean },
  q: Required<LogQuery>,
): string {
  return logPage(view, {
    tab: "runs",
    q,
    outcomes: RUN_OUTCOMES,
    list: list.runs.length > 0 ? runTable(list.runs, view.generatedAt, true) : "",
    empty: {
      none: "No runs recorded yet.",
      noMatch: "No runs match.",
    },
    more: list.more,
    lastId: list.runs.at(-1)?.id,
    noun: "runs",
  });
}
