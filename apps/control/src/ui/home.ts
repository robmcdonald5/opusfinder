import { RUN_OUTCOMES, type RunOutcome } from "@opusfinder/control";

import type { CostSummary, StatusView } from "../service";
import { ICON_CHECK, card, item, level, meter, rowList, stat } from "./components";
import { ago, esc, plural, tally, usd } from "./format";
import { layout } from "./layout";
import { isHealthCheck, modeLabel, stageHref, stageLabel } from "./vocab";

function attention(view: StatusView, c: CostSummary): string[] {
  const out: string[] = [];
  const row = (bad: boolean, title: string, end = "") =>
    item({ title: `<span class="dot${bad ? " bad" : ""}"></span>${title}`, end });
  for (const s of view.stages.filter((s) => s.overdue))
    out.push(
      row(
        true,
        `<a href="${stageHref(s.id)}">${esc(s.label)}</a> is overdue`,
        `<span class="muted">due ${esc(ago(s.nextDueAt, view.generatedAt))}</span>`,
      ),
    );
  for (const [stage, byOutcome] of Object.entries(view.recentRuns.byStage)) {
    const failed = byOutcome.error ?? 0;
    if (failed > 0)
      out.push(
        row(
          true,
          `<a href="/runs?stage=${esc(stage)}&amp;outcome=error">${esc(stageLabel(stage))}: ${plural(failed, "failed run")}</a>`,
          `<span class="muted">last 24 h</span>`,
        ),
      );
  }
  const open = view.openProposals.length;
  if (open > 0) {
    const stale = view.openProposals.filter((p) => p.stale).length;
    out.push(
      row(
        false,
        `<a href="/approvals">${plural(open, "proposal")} waiting</a>`,
        stale > 0 ? `<span class="muted">${stale} stale</span>` : "",
      ),
    );
  }
  if (c.reviewCount > 0)
    out.push(row(false, `<a href="/cost">${plural(c.reviewCount, "charge")} to review</a>`));
  const spend = level(c.cents, c.targetUsdPerMonth * 100);
  if (spend)
    out.push(
      row(
        spend === "bad",
        `<a href="/cost">Spend is ${spend === "bad" ? "over" : "near"} the monthly target</a>`,
        `<span class="muted">${usd(c.cents)} of ${usd(c.targetUsdPerMonth * 100)}</span>`,
      ),
    );
  return out;
}

function tiles(view: StatusView, c: CostSummary): string {
  const on = view.stages.filter((s) => s.effective !== "off").length;
  const stages = stat(
    "Stages running",
    `${on} of ${view.stages.length}`,
    esc(
      tally(
        view.stages.map((s) => modeLabel(s.effective, "stage")),
        ["on", "logs only", "off"],
      ),
    ),
    { href: "/stages" },
  );

  const totals = new Map<RunOutcome, number>();
  for (const byOutcome of Object.values(view.recentRuns.byStage))
    for (const o of RUN_OUTCOMES) totals.set(o, (totals.get(o) ?? 0) + (byOutcome[o] ?? 0));
  const all = [...totals.values()].reduce((a, b) => a + b, 0);
  const errors = totals.get("error") ?? 0;
  const latest = view.stages
    .map((s) => s.lastRun)
    .filter((r) => r !== null)
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
  const runs = stat(
    "Runs, last 24 h",
    String(all),
    `${errors > 0 ? `<span class="bad">${errors} failed</span>` : "0 failed"}${
      latest ? ` · last ${esc(ago(latest.started_at, view.generatedAt))}` : ""
    }`,
    // The total isn't the failure: only the "N failed" part turns red.
    { href: "/runs" },
  );

  const target = c.targetUsdPerMonth * 100;
  const spend = level(c.cents, target);
  const cost = stat(
    "Spend this month",
    usd(c.cents),
    `target ${usd(target)}${c.reviewCount > 0 ? ` · <span class="warn">${c.reviewCount} to review</span>` : ""}`,
    { href: "/cost", meter: meter(c.cents, target), ...(spend ? { tone: spend } : {}) },
  );

  const alerts = view.stages.find((s) => s.id === "alerts");
  const checks = view.policies.filter((p) => isHealthCheck(p.id));
  const health = stat(
    "Health alerts",
    esc(alerts?.effective ?? "off"),
    `${checks.length} checks: ${esc(
      tally(
        checks.map((p) => modeLabel(p.effective, "check")),
        ["emails you", "logs only", "off"],
      ),
    )}`,
    { href: "/health" },
  );

  return `<div class="stats">${stages}${runs}${cost}${health}</div>`;
}

export function renderHome(view: StatusView, c: CostSummary, flash: string | null): string {
  const needs = card({
    title: "Needs you",
    flush: true,
    body:
      rowList(attention(view, c)) ||
      `<p class="empty good">${ICON_CHECK}Nothing needs you right now.</p>`,
  });
  return layout(view, { section: "overview", flash, body: `${needs}${tiles(view, c)}` });
}
