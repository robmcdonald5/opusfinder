import type { StatusView } from "../service";
import type { ChangeRow } from "../store";
import { clip, item, rowList } from "./components";
import { esc, ts } from "./format";
import { logPage, type LogQuery } from "./log";
import { changeLine, who } from "./vocab";

type Viewer = Pick<StatusView, "caller" | "generatedAt">;

function changeItem(c: ChangeRow, v: Viewer): string {
  return item({
    title: changeLine(c.target, c.from_value, c.to_value),
    ...(c.reason ? { body: clip(c.reason) } : {}),
    lines: c.proposed_by
      ? [`proposal #${esc(c.proposal_id)} by ${who(c.proposed_by, v.caller)}`]
      : [],
    end: `<span class="muted" title="via ${esc(c.channel)}">${who(`${c.actor_role}:${c.actor_name}`, v.caller)}</span> ${ts(
      c.at,
      v.generatedAt,
    )}`,
  });
}

/** Consecutive seed rows (adoption, not decisions) fold into one line from this many on. */
const SEED_FOLD = 3;

export function changeRows(changes: readonly ChangeRow[], v: Viewer): string[] {
  const out: string[] = [];
  for (let i = 0; i < changes.length; ) {
    let j = i;
    while (j < changes.length && changes[j]?.actor_role === "seed") j++;
    const seeds = changes.slice(i, j);
    if (seeds.length >= SEED_FOLD) {
      out.push(
        `<li><details class="more"><summary>${seeds.length} starting values from the migration seed&nbsp;·&nbsp;${ts(
          seeds[0]?.at,
          v.generatedAt,
        )}</summary><ul class="rows">${seeds.map((c) => changeItem(c, v)).join("")}</ul></details></li>`,
      );
      i = j;
      continue;
    }
    const c = changes[i];
    if (c) out.push(changeItem(c, v));
    i++;
  }
  return out;
}

export function renderChanges(
  view: StatusView,
  list: { changes: ChangeRow[]; more: boolean },
  q: LogQuery,
): string {
  return logPage(view, {
    tab: "changes",
    q,
    list: rowList(changeRows(list.changes, view)),
    empty: { none: "No changes recorded.", noMatch: "No changes match." },
    more: list.more,
    lastId: list.changes.at(-1)?.id,
    noun: "changes",
  });
}
