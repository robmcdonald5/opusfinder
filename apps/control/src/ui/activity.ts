import { STAGE_IDS } from "@opusfinder/control";

import type { StatusView } from "../service";
import type { ChangeRow } from "../store";
import { esc, filterSelect, layout, stageLabel, targetLink, value, when } from "./html";

/** Activity: the append-only change log (C3) — who changed what, when, from what to what, and why. */

function changeItem(c: ChangeRow): string {
  return `<li>${targetLink(c.target)}: ${value(c.from_value)} → ${value(c.to_value)} <span class="muted">by ${esc(
    c.actor_role,
  )}:${esc(c.actor_name)} via ${esc(c.channel)}${
    c.proposed_by ? `, proposed by ${esc(c.proposed_by)} (#${esc(c.proposal_id)})` : ""
  }</span><br>${esc(c.reason)} ${when(c.at)}</li>`;
}

/** Runs of this many or more consecutive seed rows fold into one line: they record adoption, not decisions. */
const SEED_FOLD = 3;

/** The change list, shared with the stage pages. */
export function changeList(changes: readonly ChangeRow[]): string {
  if (changes.length === 0) return `<p class="muted">No changes recorded.</p>`;
  const out: string[] = [];
  for (let i = 0; i < changes.length; ) {
    let j = i;
    while (j < changes.length && changes[j]?.actor_role === "seed") j++;
    const seeds = changes.slice(i, j);
    if (seeds.length >= SEED_FOLD) {
      out.push(
        `<li><details><summary class="muted">${seeds.length} starting values from the migration seed ${when(
          seeds[0]?.at,
        )}</summary><ul class="log">${seeds.map(changeItem).join("")}</ul></details></li>`,
      );
      i = j;
      continue;
    }
    const c = changes[i];
    if (c) out.push(changeItem(c));
    i++;
  }
  return `<ul class="log">${out.join("")}</ul>`;
}

export function renderActivity(
  view: StatusView,
  list: { changes: ChangeRow[]; more: boolean },
  q: { stage: string },
): string {
  const parts: string[] = [];
  parts.push(
    `<form class="filters" method="get" action="/activity">${filterSelect(
      "stage",
      "Stage",
      STAGE_IDS,
      q.stage,
    )}<button type="submit">Show</button></form>`,
  );
  if (q.stage)
    parts.push(
      `<p class="muted">Changes to <code>${esc(q.stage)}</code>, its knobs and its overrides.</p>`,
    );
  parts.push(changeList(list.changes));
  const last = list.changes[list.changes.length - 1];
  if (list.more && last) {
    const next = new URLSearchParams();
    if (q.stage) next.set("stage", q.stage);
    next.set("before", String(last.id));
    parts.push(`<p><a href="/activity?${esc(next.toString())}">Older changes →</a></p>`);
  }
  const title = q.stage ? `Activity: ${stageLabel(q.stage)}` : "Activity";
  return layout(view, { section: "activity", title, flash: null, body: parts.join("\n") });
}
