import { stageDef } from "@opusfinder/control";

import type { StatusView } from "../service";
import { modeForm } from "./forms";
import { GATE_LONG, esc, isHealthCheck, isOwner, layout, modeLine, stageHref } from "./html";
import { knobItem } from "./stages";

/**
 * Health & alerts: the alerts stage (which runs the checks and sends the emails) and the health checks it
 * reads. One rule covers the whole page — any agent change here, quieter or louder, needs the owner
 * (owner decision 2026-10-04) — so it lives on its own page rather than among the stage policies.
 */
export function renderHealth(view: StatusView, flash: string | null): string {
  const owner = isOwner(view);
  const back = "/health";
  const parts: string[] = [];
  const alerts = view.stages.find((s) => s.id === "alerts");
  const checks = view.policies.filter((p) => isHealthCheck(p.id));

  parts.push(
    `<p class="muted">A check in <strong>enforce</strong> pages you when it fires; in <strong>shadow</strong> it is computed and logged only. Every agent change on this page needs your approval, in either direction.</p>`,
  );

  if (alerts) {
    parts.push(
      `<div class="card"><h3><a href="${stageHref(alerts.id)}">${esc(alerts.label)}</a> <code>${esc(
        alerts.id,
      )}</code></h3><p>${modeLine(alerts)}</p><p class="note">${esc(GATE_LONG[alerts.gate])} The checks run inside this stage, so no check results are recorded here yet.</p>${
        owner ? modeForm(alerts.id, alerts.modes, alerts.desired, back) : ""
      }${
        alerts.knobs.length > 0
          ? `<ul class="rows">${alerts.knobs.map((k) => knobItem(k, owner, back)).join("")}</ul>`
          : ""
      }</div>`,
    );
  }

  parts.push(`<h2>Checks (${checks.length})</h2>`);
  for (const p of checks) {
    const watched = p.watches ? stageDef(p.watches) : null;
    parts.push(`<div class="card" id="policy-${esc(p.id)}"><h3>${esc(p.label)} <code>${esc(p.id)}</code></h3>
<p>${modeLine(p)}${
      p.watches && watched
        ? ` <span class="muted">· watches <a href="${stageHref(p.watches)}">${esc(watched.label.toLowerCase())}</a>${
            p.watchedStageOff ? " (off, so this check is skipped)" : ""
          }</span>`
        : ""
    }</p>${owner ? modeForm(p.id, p.modes, p.desired, back) : ""}${
      p.knobs.length > 0
        ? `<ul class="rows">${p.knobs.map((k) => knobItem(k, owner, back)).join("")}</ul>`
        : `<p class="muted">No threshold: it fires on any occurrence.</p>`
    }</div>`);
  }

  return layout(view, {
    section: "health",
    title: "Health & alerts",
    flash,
    body: parts.join("\n"),
  });
}
