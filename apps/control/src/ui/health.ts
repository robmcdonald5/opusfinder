import { stageDef, type PolicyView } from "@opusfinder/control";

import type { StatusView } from "../service";
import { card, controlRow, rowList } from "./components";
import { knobRow, modeControl } from "./forms";
import { esc } from "./format";
import { isOwner, layout } from "./layout";
import { isHealthCheck, modeLine, stageHref, wiring } from "./vocab";

/** Any agent change on this page, quieter or louder, needs the owner (decision 2026-10-04): hence the checks' own page. */

function checkRow(p: PolicyView, edit: string | null): string {
  const watched = p.watches ? stageDef(p.watches) : null;
  return controlRow({
    id: `policy-${p.id}`,
    name: p.label,
    hover: p.id,
    lines: [
      [
        p.knobs.length > 0 ? "" : "fires on any occurrence",
        p.watches && watched
          ? `watches <a href="${stageHref(p.watches)}" title="${esc(watched.label)}">${esc(p.watches)}</a>${
              p.watchedStageOff ? ` <span class="muted">(off, so skipped)</span>` : ""
            }`
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ],
    value: modeLine(p, "check", edit && modeControl(p, "check", edit, p.label)),
    settings: p.knobs.map((k) => knobRow(k, edit)),
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
      body: rowList(checks.map((p) => checkRow(p, edit))),
    }),
  );

  return layout(view, { section: "health", flash, body: parts.join("\n") });
}
