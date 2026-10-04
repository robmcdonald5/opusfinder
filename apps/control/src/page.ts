import { INHERIT, allTargets, formatTarget, type ValueSource } from "@opusfinder/control";

import type { StatusView } from "./service";

/**
 * The one server-rendered page (§6 option d): status, overrides, policies, knobs, the approval queue and
 * the change log, plus plain HTML forms for the owner. No framework, no script, no build step — it renders
 * from the same {@link StatusView} the JSON API returns, so the page can't show something the API doesn't.
 * Every dynamic string goes through {@link esc}: reasons and notes are written by agents, so they are
 * untrusted text. Forms post to /ui/* (same-origin-checked in index.ts) and redirect back here.
 */

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e3e6;--card:#f6f6f8;--on:#1a7f37;--shadow:#9a6700;--off:#6b6b70;--bad:#cf222e;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#111214;--fg:#e8e8ea;--muted:#9a9aa1;--line:#2c2d31;--card:#1a1b1e;--on:#3fb950;--shadow:#d29922;--off:#8b8b92;--bad:#f85149;--accent:#58a6ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:16px}
h1{font-size:1.35rem;margin:0 0 4px}
h2{font-size:1.05rem;margin:28px 0 8px;padding-top:12px;border-top:1px solid var(--line)}
p{margin:6px 0}
.muted{color:var(--muted);font-size:.88rem}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.92rem}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.03em}
code{font:.85rem ui-monospace,SFMono-Regular,Menlo,monospace}
.mode{display:inline-block;padding:1px 8px;border-radius:10px;font-size:.82rem;font-weight:600;border:1px solid currentColor}
.m-on,.m-enforce{color:var(--on)}.m-shadow{color:var(--shadow)}.m-off,.m-inherit{color:var(--off)}.m-bad{color:var(--bad)}
.flash{padding:10px 12px;border-radius:8px;background:var(--card);border-left:4px solid var(--on)}
.card{background:var(--card);border-radius:8px;padding:12px;margin:10px 0}
.form{display:grid;gap:8px;max-width:520px}
label{display:grid;gap:3px;font-size:.88rem;color:var(--muted)}
input,select,button{font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);width:100%}
button{cursor:pointer;background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
button.reject{background:transparent;color:var(--bad);border-color:var(--bad)}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
ul.log{list-style:none;padding:0;margin:0}
ul.log li{padding:8px 0;border-bottom:1px solid var(--line)}
`;

function mode(value: string | null | undefined): string {
  const v = value ?? INHERIT;
  return `<span class="mode m-${esc(v)}">${esc(v)}</span>`;
}

function outcome(value: string): string {
  const cls =
    value === "ok" ? "on" : value === "skipped" ? "off" : value === "error" ? "bad" : "shadow";
  return `<span class="mode m-${cls}">${esc(value)}</span>`;
}

function sourceNote(source: ValueSource): string {
  if (source === "default") return ` <span class="muted">(default)</span>`;
  if (source === "invalid") return ` <span class="muted">(unreadable value → failed closed)</span>`;
  return "";
}

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  // ISO minus seconds/millis, in UTC: compact and unambiguous on a phone.
  return `<span class="muted">${esc(iso.slice(0, 16).replace("T", " "))} UTC</span>`;
}

const FLASH: Record<string, string> = {
  applied: "Change applied and logged.",
  noop: "Nothing to change — it already had that value.",
  approved: "Proposal approved and applied.",
  rejected: "Proposal rejected.",
};

export function renderPage(view: StatusView, flash: string | null): string {
  const isOwner = view.caller.role === "owner";
  const parts: string[] = [];

  parts.push(`<header><h1>opusfinder control</h1>
<p class="muted">Signed in as <code>${esc(view.caller.role)}:${esc(view.caller.name)}</code> · ${when(view.generatedAt)}${
    isOwner
      ? ""
      : " · read-only here (agents change things through the API or <code>pnpm ctl</code>)"
  }</p></header>`);
  if (flash && FLASH[flash]) parts.push(`<p class="flash" role="status">${esc(FLASH[flash])}</p>`);

  // ---- proposals first: on a phone, "what is waiting for me?" is the reason to open the page ----
  parts.push(`<h2>Open proposals (${view.openProposals.length})</h2>`);
  if (view.openProposals.length === 0)
    parts.push(`<p class="muted">Nothing waiting for approval.</p>`);
  for (const p of view.openProposals) {
    parts.push(`<div class="card"><p><strong>#${esc(p.id)}</strong> <code>${esc(p.target)}</code>: ${mode(
      p.from_value,
    )} → ${mode(p.to_value)}</p>
<p>${esc(p.reason)}</p>
<p class="muted">by ${esc(p.proposer)} · ${when(p.created_at)} · expires ${when(p.expires_at)}</p>${
      isOwner
        ? `<form method="post" action="/ui/proposals/${esc(p.id)}/approve">
<label>Note (optional, logged)<input name="note" maxlength="300" autocomplete="off"></label>
<div class="actions"><button type="submit">Approve</button><button type="submit" class="reject" formaction="/ui/proposals/${esc(
            p.id,
          )}/reject">Reject</button></div></form>`
        : ""
    }</div>`);
  }

  // ---- master switch + stages ----
  parts.push(`<h2>Stages</h2>
<p>Master switch: ${mode(view.global.desired)}${sourceNote(view.global.source)} <span class="muted">— off caps every stage and policy at off.</span></p>
<div class="scroll"><table><thead><tr><th>Stage</th><th>Desired</th><th>Effective</th><th>Last run</th></tr></thead><tbody>`);
  for (const s of view.stages) {
    const capped = s.cappedBy ? ` <span class="muted">(capped by ${esc(s.cappedBy)})</span>` : "";
    const run = s.lastRun
      ? `${outcome(s.lastRun.outcome)} ${when(s.lastRun.started_at)}`
      : `<span class="muted">none recorded</span>`;
    parts.push(
      `<tr><td>${esc(s.label)}<br><code>${esc(s.id)}</code></td><td>${mode(s.desired)}${sourceNote(
        s.source,
      )}</td><td>${mode(s.effective)}${capped}</td><td>${run}</td></tr>`,
    );
  }
  parts.push(`</tbody></table></div>`);

  const overrides = view.stages.flatMap((s) => s.overrides);
  parts.push(
    overrides.length === 0
      ? `<p class="muted">No slice overrides (every source and lane follows its stage).</p>`
      : `<div class="scroll"><table><thead><tr><th>Override</th><th>Set to</th><th>Effective</th></tr></thead><tbody>${overrides
          .map(
            (o) =>
              `<tr><td><code>${esc(o.target)}</code></td><td>${mode(o.override)}${sourceNote(o.source)}</td><td>${mode(o.effective)}</td></tr>`,
          )
          .join("")}</tbody></table></div>`,
  );

  // ---- policies ----
  parts.push(
    `<h2>Policies</h2><div class="scroll"><table><thead><tr><th>Policy</th><th>Desired</th><th>Effective</th><th>Notes</th></tr></thead><tbody>`,
  );
  for (const p of view.policies) {
    const notes = [
      `read by ${p.readBy.map(esc).join(", ")}`,
      p.watches
        ? `watches ${esc(p.watches)}${p.watchedStageOff ? " (stage off → skipped)" : ""}`
        : "",
      p.agent === "approval" ? "agents always need approval" : "",
    ].filter(Boolean);
    parts.push(
      `<tr><td>${esc(p.label)}<br><code>${esc(p.id)}</code></td><td>${mode(p.desired)}${sourceNote(
        p.source,
      )}</td><td>${mode(p.effective)}</td><td class="muted">${notes.join(" · ")}</td></tr>`,
    );
  }
  parts.push(`</tbody></table></div>`);

  // ---- knobs ----
  const knobs = [...view.stages.flatMap((s) => s.knobs), ...view.policies.flatMap((p) => p.knobs)];
  parts.push(
    `<h2>Knobs</h2><div class="scroll"><table><thead><tr><th>Knob</th><th>Value</th><th>Range</th><th>Riskier</th></tr></thead><tbody>`,
  );
  for (const k of knobs) {
    parts.push(
      `<tr><td>${esc(k.label)}<br><code>${esc(k.target)}</code></td><td>${esc(k.value)}${
        k.unit ? ` ${esc(k.unit)}` : ""
      }${sourceNote(k.source)}</td><td class="muted">${esc(k.min)}–${esc(k.max)} (default ${esc(k.default)})</td><td class="muted">${
        k.riskier === "up" ? "higher" : "lower"
      }</td></tr>`,
    );
  }
  parts.push(`</tbody></table></div>`);

  // ---- owner forms ----
  if (isOwner) parts.push(renderForms(view));

  // ---- change log ----
  parts.push(`<h2>Recent changes</h2><ul class="log">`);
  if (view.recentChanges.length === 0) parts.push(`<li class="muted">No changes recorded.</li>`);
  for (const c of view.recentChanges) {
    parts.push(
      `<li><code>${esc(c.target)}</code>: ${mode(c.from_value)} → ${mode(c.to_value)} <span class="muted">by ${esc(
        c.actor_role,
      )}:${esc(c.actor_name)} via ${esc(c.channel)}${c.proposed_by ? `, proposed by ${esc(c.proposed_by)} (#${esc(c.proposal_id)})` : ""}</span><br>${esc(
        c.reason,
      )} ${when(c.at)}</li>`,
    );
  }
  parts.push(`</ul>`);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>opusfinder control</title><style>${STYLE}</style></head>
<body><main>${parts.join("\n")}</main></body></html>`;
}

function option(value: string, label: string): string {
  return `<option value="${esc(value)}">${esc(label)}</option>`;
}

function renderForms(view: StatusView): string {
  const targets = allTargets();
  const modeTargets = targets.filter((t) => t.kind === "mode").map(formatTarget);
  const desired = new Map<string, string>([
    ["global", view.global.desired],
    ...view.stages.map((s) => [s.id, s.desired] as [string, string]),
    ...view.policies.map((p) => [p.id, p.desired] as [string, string]),
  ]);
  const knobs = [...view.stages.flatMap((s) => s.knobs), ...view.policies.flatMap((p) => p.knobs)];
  const overrides = new Map(
    view.stages.flatMap((s) => s.overrides).map((o) => [o.target, o.override]),
  );
  const dimTargets = targets.filter((t) => t.kind === "dim").map(formatTarget);
  const reason = `<label>Reason (required, logged)<input name="reason" required maxlength="300" autocomplete="off"></label>`;

  return `<h2>Change settings</h2>
<div class="card"><form class="form" method="post" action="/ui/change">
<strong>Flip a mode</strong>
<label>Switch<select name="target">${modeTargets.map((t) => option(t, `${t} (now ${desired.get(t) ?? "?"})`)).join("")}</select></label>
<label>New mode<select name="value">${["off", "shadow", "on", "enforce"].map((m) => option(m, m)).join("")}</select></label>
${reason}<button type="submit">Apply</button></form></div>
<div class="card"><form class="form" method="post" action="/ui/change">
<strong>Set a knob</strong>
<label>Knob<select name="target">${knobs
    .map((k) => option(k.target, `${k.target} (now ${k.value}; ${k.min}–${k.max})`))
    .join("")}</select></label>
<label>New value<input name="value" inputmode="decimal" required autocomplete="off"></label>
${reason}<button type="submit">Apply</button></form></div>
<div class="card"><form class="form" method="post" action="/ui/change">
<strong>Narrow one source or lane</strong>
<label>Slice<select name="target">${dimTargets
    .map((t) => option(t, `${t}${overrides.has(t) ? ` (now ${overrides.get(t)})` : ""}`))
    .join("")}</select></label>
<label>Override<select name="value">${["off", "shadow", "on", INHERIT].map((m) => option(m, m === INHERIT ? "inherit (clear)" : m)).join("")}</select></label>
${reason}<button type="submit">Apply</button></form></div>
<p class="muted">Invalid combinations (e.g. <code>shadow</code> on a stage without it) are refused with the reason.</p>`;
}

export function renderError(status: number, code: string, message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>opusfinder control: ${esc(status)}</title><style>${STYLE}</style></head>
<body><main><h1>${esc(status)} — ${esc(code)}</h1><p>${esc(message)}</p><p><a href="/">Back to the control page</a></p></main></body></html>`;
}
