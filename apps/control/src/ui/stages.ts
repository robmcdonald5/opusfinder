import { STAGE_IDS, stageDef, type KnobView, type PolicyView } from "@opusfinder/control";

import type { RunView, StatusView } from "../service";
import type { ChangeRow } from "../store";
import { changeList } from "./activity";
import { knobForm, modeForm, overrideForm } from "./forms";
import {
  GATE_LONG,
  GATE_SHORT,
  GATE_UNREADABLE,
  ago,
  dueText,
  duration,
  esc,
  isHealthCheck,
  isOwner,
  layout,
  mode,
  modeLine,
  num,
  outcome,
  period,
  sourceNote,
  stageHref,
  targetHref,
  trigger,
} from "./html";
import { runTable } from "./runs";

/** Stages: the master switch, one row per stage (each with its own page), and the lifecycle policies. */

type StageRow = StatusView["stages"][number];

const APPROVAL_NOTE = `<span class="muted">· agents need your approval for any change here</span>`;

function lastRunLine(s: StageRow, nowIso: string): string {
  const last = s.lastRun
    ? `last run ${outcome(s.lastRun.outcome)} ${esc(ago(s.lastRun.started_at, nowIso))}${
        s.lastRun.duration_ms !== null ? `, took ${esc(duration(s.lastRun.duration_ms))}` : ""
      }`
    : `<span class="muted">no run recorded</span>`;
  const due = dueText(s, nowIso);
  return due ? `${last} · ${due}` : last;
}

/** A knob as a list item, with its change form for the owner. Shared with the health page. */
export function knobItem(k: KnobView, owner: boolean, back: string): string {
  const unit = k.unit ? ` ${esc(k.unit)}` : "";
  return `<li><strong>${esc(k.label)}</strong>: ${esc(num(k.value))}${unit}${sourceNote(k.source)} <code>${esc(
    k.target,
  )}</code><br><span class="muted">${esc(num(k.min))}–${esc(num(k.max))}${unit}, default ${esc(num(k.default))}${unit} · ${
    k.riskier === "up" ? "higher" : "lower"
  } spends or risks more${k.legacyEnv ? ` · env var today: <code>${esc(k.legacyEnv)}</code>` : ""}${
    k.agent === "approval" ? " · agents need approval" : ""
  }</span>${owner ? knobForm(k, back) : ""}</li>`;
}

function readersLine(p: PolicyView): string {
  return p.readBy
    .map(
      (id) => `<a href="${stageHref(id)}">${esc(id)}</a> (${esc(GATE_SHORT[stageDef(id).gate])})`,
    )
    .join(", ");
}

/** A lifecycle policy (close, stale_sweep): mode, readers, knobs, forms. */
function policyCard(p: PolicyView, owner: boolean, back: string): string {
  return `<div class="card" id="policy-${esc(p.id)}"><h3>${esc(p.label)} <code>${esc(p.id)}</code></h3>
<p>${modeLine(p)}</p>
<p class="muted">Read by ${readersLine(p)}${p.agent === "approval" ? " · agents need approval" : ""}</p>${
    owner ? modeForm(p.id, p.modes, p.desired, back) : ""
  }${p.knobs.length > 0 ? `<ul class="rows">${p.knobs.map((k) => knobItem(k, owner, back)).join("")}</ul>` : ""}</div>`;
}

/** One sentence on what the switches do today, derived from each stage's `gate` in the registry. */
function wiringNote(): string {
  const by = (g: "unwired" | "shadow" | "enforced") =>
    STAGE_IDS.filter((id) => stageDef(id).gate === g);
  const enforced = by("enforced");
  const shadow = by("shadow");
  const unwired = by("unwired");
  const parts = [
    enforced.length > 0 ? `${enforced.join(", ")} obey their switches` : "",
    shadow.length > 0
      ? `${shadow.join(", ")} read their switches in shadow (logged, not obeyed)`
      : "",
    unwired.length > 0 ? `${unwired.join(", ")} don't read them yet` : "",
  ].filter(Boolean);
  return unwired.length + shadow.length === 0
    ? ""
    : `<p class="note">Not everything obeys this page yet: ${esc(parts.join("; "))}. Until a stage is enforced, its env vars, code constants and vendor pauses still decide what runs; a change here is recorded (and, in shadow, logged by the runtime).</p>`;
}

export function renderStages(view: StatusView, flash: string | null): string {
  const owner = isOwner(view);
  const back = "/stages";
  const parts: string[] = [wiringNote()];

  parts.push(`<div class="card" id="global"><h3>${esc(view.global.label)}</h3>
<p>${mode(view.global.desired)}${sourceNote(view.global.source)} <span class="muted">— off caps every stage and policy at off.</span> ${
    view.global.agent === "approval" ? APPROVAL_NOTE : ""
  }</p>${owner ? modeForm("global", view.global.modes, view.global.desired, back) : ""}</div>`);

  parts.push(
    `<h2>Stages</h2><ul class="rows">${view.stages
      .map(
        (
          s,
        ) => `<li><a href="${stageHref(s.id)}"><strong>${esc(s.label)}</strong></a> ${modeLine(s)}${
          s.overrides.length > 0
            ? ` <span class="muted">· ${s.overrides.length} slice override${s.overrides.length === 1 ? "" : "s"}</span>`
            : ""
        }
<br><span class="muted"><code>${esc(s.id)}</code> · ${esc(s.runtime)} · ${trigger(s.trigger)} · ${esc(
          GATE_SHORT[s.gate],
        )}</span>
<br>${lastRunLine(s, view.generatedAt)}</li>`,
      )
      .join("")}</ul>`,
  );

  const lifecycle = view.policies.filter((p) => !isHealthCheck(p.id));
  parts.push(
    `<h2 id="policies">Policies</h2><p class="muted">Behaviour switches the stages read while they run. The health checks are under <a href="/health">Health &amp; alerts</a>.</p>${lifecycle
      .map((p) => policyCard(p, owner, back))
      .join("")}`,
  );

  return layout(view, { section: "stages", title: "Stages", flash, body: parts.join("\n") });
}

function budgetLine(s: StageRow): { target: string; runaway: string } {
  const b = s.budget;
  const r = b?.runaway;
  return {
    target:
      b?.targetUsdPerMonth !== undefined ? `$${esc(b.targetUsdPerMonth)}/month (advisory)` : "",
    runaway: r
      ? r.unit === "usd"
        ? `stop above $${esc(r.perDay)}/day`
        : `stop above ${esc(num(r.perDay))} <code>${esc(r.unit)}</code>/day`
      : "",
  };
}

export function renderStage(
  view: StatusView,
  s: StageRow,
  runs: readonly RunView[],
  changes: readonly ChangeRow[],
  flash: string | null,
): string {
  const owner = isOwner(view);
  const back = stageHref(s.id);
  const parts: string[] = [];
  const budget = budgetLine(s);
  const fact = (dt: string, dd: string) => (dd ? `<dt>${esc(dt)}</dt><dd>${dd}</dd>` : "");

  parts.push(
    `<p><code>${esc(s.id)}</code> · ${modeLine(s)}</p><p class="note">${esc(GATE_LONG[s.gate])}</p>`,
  );
  parts.push(
    `<dl class="facts">${[
      fact(
        "Runs on",
        `<code>${esc(s.runtime)}</code>${s.platformId ? ` · <code>${esc(s.platformId)}</code>` : ""}`,
      ),
      fact("Schedule", trigger(s.trigger)),
      fact(
        "Expected",
        s.expect
          ? `every ${esc(period(s.expect.everyMin))}; flagged overdue ${esc(period(s.expect.graceMin))} after a missed run`
          : "",
      ),
      fact("Last run", lastRunLine(s, view.generatedAt)),
      fact("Modes", s.modes.map(mode).join(" ")),
      fact("Shadow means", s.shadowMeans ? esc(s.shadowMeans) : ""),
      fact("Watchdog", s.heartbeat ? `<code>${esc(s.heartbeat)}</code>` : ""),
      fact("Monthly target", budget.target),
      fact("Runaway guard", budget.runaway),
      fact(
        "Agents",
        s.agent === "approval"
          ? "need your approval for any change"
          : "may turn it down or off; anything up needs your approval",
      ),
      fact("Control plane down", esc(GATE_UNREADABLE[s.gate])),
    ].join("")}</dl>`,
  );
  if (owner) parts.push(modeForm(s.id, s.modes, s.desired, back));

  if (s.knobs.length > 0)
    parts.push(
      `<h2>Knobs</h2><ul class="rows">${s.knobs.map((k) => knobItem(k, owner, back)).join("")}</ul>`,
    );

  for (const [dim, values] of Object.entries(s.dims)) {
    const set = s.overrides.filter((o) => o.dim === dim);
    parts.push(
      `<h2>Per ${esc(dim)}</h2><p class="muted">Turn one ${esc(dim)} down without touching the rest. Known: ${values
        .map(esc)
        .join(", ")}.</p>${
        set.length === 0
          ? `<p>Every ${esc(dim)} follows the stage.</p>`
          : `<ul class="rows">${set
              .map(
                (o) =>
                  `<li><strong>${esc(o.value)}</strong>: set to ${mode(o.override)}${sourceNote(o.source)}, runs as ${mode(
                    o.effective,
                  )}</li>`,
              )
              .join("")}</ul><p class="muted">The rest follow the stage.</p>`
      }${owner && values ? overrideForm(s, dim, values, back) : ""}`,
    );
  }

  const reads = view.policies.filter((p) => (p.readBy as readonly string[]).includes(s.id));
  if (reads.length > 0)
    parts.push(
      `<h2>Policies it reads</h2><ul class="rows">${reads
        .map(
          (p) =>
            `<li><a href="${esc(targetHref(p.id) ?? "/stages")}">${esc(p.label)}</a> <code>${esc(
              p.id,
            )}</code>: ${mode(p.effective)}</li>`,
        )
        .join("")}</ul>`,
    );

  const watching = view.policies.filter((p) => p.watches === s.id);
  if (watching.length > 0)
    parts.push(
      `<h2>Health checks watching it</h2><ul class="rows">${watching
        .map(
          (p) =>
            `<li><a href="/health">${esc(p.label)}</a> <code>${esc(p.id)}</code>: ${mode(p.effective)}${
              p.watchedStageOff
                ? ` <span class="muted">(skipped while this stage is off)</span>`
                : ""
            }</li>`,
        )
        .join("")}</ul>`,
    );

  parts.push(
    `<h2>Recent runs</h2>${runTable(runs, view.generatedAt, false)}<p><a href="/runs?stage=${esc(s.id)}">All ${esc(
      s.id,
    )} runs →</a></p>`,
  );
  parts.push(
    `<h2>Recent changes</h2>${changeList(changes)}<p><a href="/activity?stage=${esc(s.id)}">All ${esc(
      s.id,
    )} changes →</a></p>`,
  );

  return layout(view, { section: "stages", title: s.label, flash, body: parts.join("\n") });
}
