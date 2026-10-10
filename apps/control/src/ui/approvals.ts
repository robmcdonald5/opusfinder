import type { StatusView } from "../service";
import { esc, isOwner, layout, mode, targetLink, value, when } from "./html";

/** Approvals: the open proposals (Approve / Reject) and the recently closed ones. */
export function renderApprovals(view: StatusView, flash: string | null): string {
  const owner = isOwner(view);
  const parts: string[] = [];

  parts.push(
    `<p class="muted">An agent files a proposal for any change it may not make itself (anything that turns something on, raises spend, or touches alerting). It lapses after 7 days.</p>`,
  );
  parts.push(`<h2>Open proposals (${view.openProposals.length})</h2>`);
  if (view.openProposals.length === 0)
    parts.push(`<p class="muted">Nothing waiting for approval.</p>`);
  for (const p of view.openProposals) {
    parts.push(`<div class="card"><p><strong>#${esc(p.id)}</strong> ${targetLink(p.target)}: ${value(
      p.from_value,
    )} → ${value(p.to_value)}</p>
<p>${esc(p.reason)}</p>
<p class="muted">by ${esc(p.proposer)} · ${when(p.created_at)} · expires ${when(p.expires_at)}</p>${
      p.stale
        ? `<p class="warn">Stale: <code>${esc(p.target)}</code> is now ${value(p.current)}, not ${value(
            p.from_value,
          )}. Approving would be refused; reject it and let the agent re-propose.</p>`
        : ""
    }${
      owner
        ? `<form method="post" action="/ui/proposals/${esc(p.id)}/${p.stale ? "reject" : "approve"}">
<label>Note (optional, logged)<input name="note" maxlength="300" autocomplete="off"></label>
<div class="actions">${
            p.stale
              ? `<button type="submit" class="reject">Reject</button>`
              : `<button type="submit">Approve</button><button type="submit" class="reject" formaction="/ui/proposals/${esc(
                  p.id,
                )}/reject">Reject</button>`
          }</div></form>`
        : ""
    }</div>`);
  }

  parts.push(`<h2>Recently closed (${view.closedProposals.length})</h2>`);
  if (view.closedProposals.length === 0) parts.push(`<p class="muted">None yet.</p>`);
  else
    parts.push(
      `<ul class="log">${view.closedProposals
        .map(
          (c) =>
            `<li><strong>#${esc(c.id)}</strong> ${targetLink(c.target)}: ${value(c.from_value)} → ${value(
              c.to_value,
            )} ${mode(c.status)} <span class="muted">by ${esc(c.proposer)}${
              c.decided_by ? `, closed by ${esc(c.decided_by)}` : ""
            } ${when(c.decided_at ?? c.expires_at)}</span><br>${esc(c.reason)}${
              c.decision_note ? `<br><span class="muted">Note: ${esc(c.decision_note)}</span>` : ""
            }</li>`,
        )
        .join("")}</ul>`,
    );

  return layout(view, { section: "approvals", title: "Approvals", flash, body: parts.join("\n") });
}
