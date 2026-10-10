import { RUN_OUTCOMES, type RunOutcome } from "@opusfinder/control";

import type { CostSummary, StatusView } from "../service";
import { usd } from "./cost";
import {
  SECTIONS,
  ago,
  esc,
  isHealthCheck,
  layout,
  outcome,
  stageLabel,
  type SectionId,
} from "./html";

/**
 * The home page: one card per section, each with a one-line live status, so the selector doubles as the
 * at-a-glance view. Ordered "what needs me" first (SECTIONS). Everything comes from the one status read.
 */

function count<T extends string>(values: readonly T[]): Map<T, number> {
  const out = new Map<T, number>();
  for (const v of values) out.set(v, (out.get(v) ?? 0) + 1);
  return out;
}

/** "3 on · 4 off" in a fixed mode order, skipping zeros. */
function tally(values: readonly string[], order: readonly string[]): string {
  const c = count(values);
  return order
    .filter((m) => (c.get(m) ?? 0) > 0)
    .map((m) => `${c.get(m)} ${m}`)
    .join(" · ");
}

function statusLine(view: StatusView, c: CostSummary, id: SectionId): string {
  switch (id) {
    case "approvals": {
      const open = view.openProposals.length;
      if (open === 0) return `<span class="muted">Nothing waiting</span>`;
      const stale = view.openProposals.filter((p) => p.stale).length;
      return `<span class="warn">${open} waiting</span>${stale > 0 ? ` <span class="muted">· ${stale} stale</span>` : ""}`;
    }
    case "stages": {
      const overdue = view.stages.filter((s) => s.overdue);
      return `${esc(
        tally(
          view.stages.map((s) => s.effective),
          ["on", "shadow", "off"],
        ),
      )}${
        overdue.length > 0
          ? ` · <span class="bad">${overdue.length} overdue (${overdue.map((s) => esc(s.id)).join(", ")})</span>`
          : ""
      }`;
    }
    case "health": {
      const alerts = view.stages.find((s) => s.id === "alerts");
      const checks = view.policies.filter((p) => isHealthCheck(p.id));
      return `alerts ${esc(alerts?.effective ?? "?")} · ${checks.length} checks: ${esc(
        tally(
          checks.map((p) => p.effective),
          ["enforce", "shadow", "off"],
        ),
      )}`;
    }
    case "runs": {
      const totals = new Map<RunOutcome, number>();
      for (const byOutcome of Object.values(view.recentRuns.byStage)) {
        for (const o of RUN_OUTCOMES) totals.set(o, (totals.get(o) ?? 0) + (byOutcome[o] ?? 0));
      }
      const all = [...totals.values()].reduce((a, b) => a + b, 0);
      const errors = totals.get("error") ?? 0;
      const latest = view.stages
        .map((s) => s.lastRun)
        .filter((r) => r !== null)
        .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
      const last = latest
        ? ` <span class="muted">· last: ${esc(stageLabel(latest.stage).toLowerCase())} ${outcome(latest.outcome)} ${esc(
            ago(latest.started_at, view.generatedAt),
          )}</span>`
        : "";
      return `${all} in 24 h · ${
        errors > 0 ? `<span class="bad">${errors} failed</span>` : "0 failed"
      }${last}`;
    }
    case "cost": {
      const review =
        c.reviewCount > 0 ? ` · <span class="warn">${c.reviewCount} to review</span>` : "";
      return c.recorded === 0 && c.reviewCount === 0
        ? `<span class="muted">No statements yet</span>`
        : `${usd(c.cents)} this month <span class="muted">of a ${usd(
            c.targetUsdPerMonth * 100,
          )} target</span>${review}`;
    }
    case "activity": {
      const c = view.recentChanges[0];
      return c
        ? `<span class="muted">Last change ${esc(ago(c.at, view.generatedAt))} by <code>${esc(
            c.actor_role,
          )}:${esc(c.actor_name)}</code></span>`
        : `<span class="muted">No changes recorded</span>`;
    }
  }
}

export function renderHome(view: StatusView, c: CostSummary, flash: string | null): string {
  const tiles = SECTIONS.map(
    (s) => `<a class="tile" href="${s.path}"><h2>${esc(s.title)}</h2>
<p class="muted">${esc(s.blurb)}</p><p class="status">${statusLine(view, c, s.id)}</p></a>`,
  ).join("\n");
  return layout(view, {
    section: "home",
    title: "opusfinder control",
    flash,
    body: `<div class="tiles">${tiles}</div>`,
  });
}
