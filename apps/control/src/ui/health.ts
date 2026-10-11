import type { PolicyView } from "@opusfinder/control";

import type { StatusView } from "../service";
import { card, controlRow, groupRow, rowList } from "./components";
import { knobRow, modeControl } from "./forms";
import { esc } from "./format";
import { isOwner, layout } from "./layout";
import { isHealthCheck, mode, modeLine, stageHref, wiring } from "./vocab";

/** Any agent change on this page, quieter or louder, needs the owner (decision 2026-10-04): hence the checks' own page. */

function checkRow(p: PolicyView, edit: string | null): string {
  return controlRow({
    id: `policy-${p.id}`,
    name: p.label,
    hover: p.knobs.length > 0 ? p.id : `${p.id}: fires on any occurrence`,
    idle: p.watchedStageOff === true,
    value: modeLine(p, "check", edit && modeControl(p, "check", edit, p.label)),
    settings: p.knobs.map((k) => knobRow(k, edit)),
  });
}

/** Checks under a band for the stage each watches, in registry order; the band carries that stage's mode. */
function checkRows(view: StatusView, checks: readonly PolicyView[], edit: string | null): string[] {
  const watched = [...new Set(checks.map((p) => p.watches))];
  return watched.flatMap((id) => {
    const rows = checks.filter((p) => p.watches === id).map((p) => checkRow(p, edit));
    const stage = view.stages.find((s) => s.id === id);
    if (!stage) return rows;
    return [
      groupRow(
        `<a href="${stageHref(stage.id)}" title="${esc(stage.id)}">${esc(stage.label)}</a>`,
        mode(stage.effective, "stage"),
      ),
      ...rows,
    ];
  });
}

export function renderHealth(view: StatusView, flash: string | null): string {
  const edit = isOwner(view) ? "/health" : null;
  const alerts = view.stages.find((s) => s.id === "alerts");
  const checks = view.policies.filter((p) => isHealthCheck(p.id));
  const parts: string[] = [];

  if (alerts)
    parts.push(
      card({
        flush: true,
        body: rowList([
          controlRow({
            name: alerts.label,
            href: stageHref(alerts.id),
            hover: alerts.id,
            lines: [wiring(alerts.gate)],
            value: modeLine(
              alerts,
              "stage",
              edit && modeControl(alerts, "stage", edit, alerts.label),
            ),
            settings: alerts.knobs.map((k) => knobRow(k, edit)),
          }),
        ]),
      }),
    );

  parts.push(
    card({
      title: `Checks (${checks.length})`,
      flush: true,
      body: rowList(checkRows(view, checks, edit)),
    }),
  );

  return layout(view, { section: "health", flash, body: parts.join("\n") });
}
