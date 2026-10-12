import { CLOSED_OUTCOMES, type ProposalView, type StatusView } from "../service";
import { card, clip, empty, fold, item, rowList } from "./components";
import { ago, esc, ts } from "./format";
import { isOwner, layout } from "./layout";
import { logPage, type LogQuery } from "./log";
import { changeLine, mode, value, who } from "./vocab";

/** An open proposal's reason is shown whole (it's what the owner decides on); a closed one's is clipped. */

function closedItem(c: ProposalView, view: StatusView): string {
  return item({
    title: changeLine(c.target, c.from_value, c.to_value),
    body: clip(c.reason),
    lines: [
      `#${esc(c.id)} by ${who(c.proposer, view.caller)}${
        c.decided_by ? `, closed by ${who(c.decided_by, view.caller)}` : ""
      }${c.decision_note ? ` · note: ${esc(c.decision_note)}` : ""}`,
    ],
    end: `${mode(c.status)} ${ts(c.decided_at ?? c.expires_at, view.generatedAt)}`,
  });
}

function openCard(p: StatusView["openProposals"][number], view: StatusView): string {
  const now = view.generatedAt;
  const stale = !p.stale
    ? ""
    : p.current === p.from_value
      ? `<p class="banner warn">Stale: ${value(p.to_value, p.target)} is no longer allowed.</p>`
      : `<p class="banner warn">Stale: it is now ${value(p.current, p.target)}, not ${value(p.from_value, p.target)}.</p>`;
  const form = isOwner(view)
    ? `<form class="actions" method="post" action="/ui/proposals/${esc(p.id)}/${p.stale ? "reject" : "approve"}">${
        p.stale
          ? `<button type="submit" class="danger">Reject</button>`
          : `<button type="submit" class="primary">Approve</button><button type="submit" class="danger" formaction="/ui/proposals/${esc(
              p.id,
            )}/reject">Reject</button>`
      }</form>`
    : "";
  return card({
    titleHtml: changeLine(p.target, p.from_value, p.to_value),
    aside: `<span class="muted">#${esc(p.id)}</span>`,
    body: `<p>${esc(p.reason)}</p><p class="sub">${who(p.proposer, view.caller)} · filed ${ts(
      p.created_at,
      now,
    )} · expires ${esc(ago(p.expires_at, now))}</p>${stale}${form}`,
  });
}

export function renderApprovals(view: StatusView, flash: string | null): string {
  const open =
    view.openProposals.length === 0
      ? card({
          title: "Open proposals (0)",
          flush: true,
          body: empty("Nothing waiting for approval."),
        })
      : view.openProposals.map((p) => openCard(p, view)).join("\n");
  const closed = fold({
    title: `Recently closed (${view.closedProposals.length})`,
    body: rowList(
      view.closedProposals.map((c) => closedItem(c, view)),
      "None yet.",
    ),
  });
  return layout(view, { section: "approvals", flash, body: `${open}\n${closed}` });
}

export function renderProposals(
  view: StatusView,
  list: { proposals: ProposalView[]; more: boolean },
  q: Required<LogQuery>,
): string {
  return logPage(view, {
    tab: "proposals",
    q,
    outcomes: CLOSED_OUTCOMES,
    list: rowList(list.proposals.map((c) => closedItem(c, view))),
    empty: { none: "No proposals closed yet.", noMatch: "No closed proposals match." },
    more: list.more,
    lastId: list.proposals.at(-1)?.id,
    noun: "proposals",
  });
}
