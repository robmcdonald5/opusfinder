import type { CostView, StatementView, StatusView } from "../service";
import {
  GMAIL_LINK,
  STATEMENT_KINDS,
  isConfirmationRow,
  isGmailConfirmation,
  vendorLabel,
} from "../statements";
import {
  card,
  clip,
  filterForm,
  item,
  level,
  meter,
  periodFields,
  rowList,
  stat,
  type Change,
} from "./components";
import {
  day,
  esc,
  monthEnd,
  monthName,
  monthShort,
  monthSpan,
  shiftMonth,
  ts,
  usd,
} from "./format";
import { isOwner, layout } from "./layout";
import { mode, who } from "./vocab";

/** Amounts are US cents in the data; the page calls each statement a "charge". */

/** A hand entry's sender is who entered it; an older entry, stored without one, names its last editor. */
const enteredBy = (s: StatementView) => s.sender ?? s.updated_by;

function source(s: StatementView, view: StatusView): string {
  if (s.source === "manual") return `entered by ${who(enteredBy(s), view.caller)}`;
  const subject = (s.subject ?? "").replace(/^(fwd?|fw):\s*/i, "");
  return `<span title="${esc(`from ${s.sender ?? "unknown sender"}: ${s.subject ?? ""}`)}">${esc(
    subject || (s.sender ?? "unknown sender"),
  )}</span>`;
}

function fields(s: Partial<StatementView>, extra = ""): string {
  const kind = s.kind ?? "other";
  return `<label>Vendor<input name="vendor" required maxlength="80" autocomplete="off" value="${esc(s.vendor ?? "")}"></label>
<label>Amount (USD)<input name="amount" type="number" inputmode="decimal" min="0" step="0.01" required value="${
    // Pre-filled only with a USD amount: a non-USD or unknown-currency figure isn't what it asks for.
    s.amount_cents != null && s.currency === "USD" ? esc((s.amount_cents / 100).toFixed(2)) : ""
  }"></label>
<label>Charged on<input name="chargedOn" type="date" required value="${esc(s.charged_on ?? "")}"></label>
<label>Service period starts (optional)<input name="periodStart" type="date" value="${esc(
    s.period_start ?? "",
  )}"></label>
<label>Kind<select name="kind">${STATEMENT_KINDS.map(
    (k) => `<option value="${k}"${k === kind ? " selected" : ""}>${k}</option>`,
  ).join("")}</select></label>${extra}
<label class="full">Note (optional)<input name="note" maxlength="300" autocomplete="off" value="${
    // A counted row's note is the owner's own: keep it on edit. Other rows' notes are the mailbox's reasons.
    s.status === "recorded" ? esc(s.note ?? "") : ""
  }"></label>`;
}

function decideForm(s: StatementView, label: string): Change {
  return {
    label,
    body: `<form class="form two" method="post" action="/ui/statements/${esc(
      s.id,
    )}">${fields(s)}<div class="actions"><button type="submit" name="action" value="count" class="primary">Count it</button><button type="submit" name="action" value="exclude" class="danger" formnovalidate>Don&#39;t count</button></div></form>`,
  };
}

/** Only ever a Google mail-settings URL (GMAIL_LINK), and only shown to the owner. */
function confirmLink(s: StatementView): string {
  if (!isGmailConfirmation(s.sender)) return "";
  const link = GMAIL_LINK.exec(s.note ?? "")?.[0];
  return link
    ? `<a href="${esc(link)}" rel="noreferrer noopener" target="_blank">Open Gmail's confirmation link</a>`
    : "";
}

/** An agent's hand entry starts with the service's "Added by …: count it or don't."; the row already says who, so only the agent's own words are kept. */
function noteText(s: StatementView): string {
  const note = s.note ?? "";
  const boiler = `Added by ${enteredBy(s)}: count it or don't.`;
  return s.source === "manual" && note.startsWith(boiler) ? note.slice(boiler.length).trim() : note;
}

/** The source goes last on the facts line: it varies most, so it's what an ellipsis cuts. */
function statementItem(
  s: StatementView,
  view: StatusView,
  o: {
    received?: boolean;
    noteCls?: string;
    status?: boolean;
    change?: Change | false;
    extra?: string;
  } = {},
): string {
  const now = view.generatedAt;
  const facts = [
    s.charged_on ? `charged ${day(s.charged_on, now)}` : "no charge date",
    s.period_start ? `for ${monthShort(s.period_start, now)}` : "",
    s.reference ? `#${esc(s.reference)}` : "",
    o.received ? `received ${ts(s.received_at, now)}` : "",
    source(s, view),
  ].filter(Boolean);
  const note = noteText(s);
  return item({
    title: `<strong title="${esc(s.vendor ?? "")}">${esc(vendorLabel(s.vendor))}</strong> <span class="muted">${esc(s.kind)}</span>`,
    ...(note ? { body: clip(note, o.noteCls ?? "muted") } : {}),
    lines: [facts.join(" · "), o.extra ?? ""],
    end: `${o.status ? mode(s.status) : ""}${
      s.amount_cents === null || s.currency === "USD"
        ? `<strong>${usd(s.amount_cents)}</strong>`
        : `<strong>${(s.amount_cents / 100).toFixed(2)}</strong> ${esc(s.currency ?? "currency?")}`
    }`,
    change: o.change,
  });
}

export function renderCost(view: StatusView, c: CostView, flash: string | null): string {
  const owner = isOwner(view);
  const parts: string[] = [];
  const byMonth = new Map(c.months.map((m) => [m.month, m]));
  const current = byMonth.get(c.currentMonth);
  const lastMonth = shiftMonth(c.currentMonth, -1);
  const last = byMonth.get(lastMonth);
  const targetCents = c.targetUsdPerMonth * 100;
  const count = current ? current.vendors.reduce((n, v) => n + v.n, 0) : 0;
  const tone = level(current?.cents ?? 0, targetCents);
  const lastTone = level(last?.cents ?? 0, targetCents);

  parts.push(
    `<div class="stats">${stat(
      `${monthName(c.currentMonth)} so far`,
      usd(current?.cents ?? 0),
      `${count} charge${count === 1 ? "" : "s"}`,
      { meter: meter(current?.cents ?? 0, targetCents), ...(tone ? { tone } : {}) },
    )}${stat(monthName(lastMonth), usd(last?.cents ?? 0), "", {
      meter: meter(last?.cents ?? 0, targetCents),
      ...(lastTone ? { tone: lastTone } : {}),
    })}${stat("Monthly target", usd(targetCents), "")}</div>`,
  );

  if (c.reviewCount > 0)
    parts.push(
      card({
        title: `Needs your review (${c.reviewCount})`,
        ...(c.reviewCount > c.review.length
          ? { aside: `<span class="muted">newest ${c.review.length}</span>` }
          : {}),
        flush: true,
        body: rowList(
          c.review.map((s) =>
            statementItem(s, view, {
              received: true,
              noteCls: "warn",
              extra:
                s.sameAs === null
                  ? ""
                  : `<span class="warn">Same charge as #${esc(s.sameAs)}, already counted.</span>`,
              change: owner && decideForm(s, "Review"),
            }),
          ),
        ),
      }),
    );

  const total = c.months
    .filter((m) => m.month >= c.month && m.month <= c.toMonth)
    .reduce((n, m) => n + m.cents, 0);
  // Charges are filed by month, so the period widens to whole months.
  parts.push(
    filterForm("/cost", periodFields(`${c.month}-01`, monthEnd(c.toMonth))) +
      card({
        id: "month",
        title: `${monthSpan(c.month, c.toMonth)} · ${usd(total)}`,
        flush: true,
        body: rowList(
          c.statements.map((s) =>
            statementItem(s, view, { change: owner && decideForm(s, "Change") }),
          ),
          "No charges in this period.",
        ),
      }),
  );

  if (c.months.length > 0)
    parts.push(
      card({
        title: "By month",
        flush: true,
        body: rowList(
          c.months.map((m) =>
            item({
              title: `<a href="/cost?from=${esc(m.month)}-01&amp;to=${esc(monthEnd(m.month))}#month">${esc(monthName(m.month))}</a>`,
              lines: [
                m.vendors.map((v) => `${esc(vendorLabel(v.vendor))} ${usd(v.cents)}`).join(" · "),
              ],
              end:
                m.cents > targetCents
                  ? `<span class="bad">${usd(m.cents)}</span>`
                  : `<strong>${usd(m.cents)}</strong>`,
            }),
          ),
        ),
      }),
    );

  if (c.notCounted.length > 0)
    parts.push(
      card({
        body: `<details class="more"><summary>Not counted (${c.notCountedCount})${
          c.notCountedCount > c.notCounted.length
            ? ` <span class="muted">newest ${c.notCounted.length}</span>`
            : ""
        }</summary>${rowList(
          c.notCounted.map((s) =>
            statementItem(s, view, {
              received: true,
              status: true,
              extra: owner ? confirmLink(s) : "",
              change: owner && !isConfirmationRow(s) && decideForm(s, "Count it"),
            }),
          ),
        )}</details>`,
      }),
    );

  if (owner)
    parts.push(
      card({
        body: `<details class="more"><summary>Add a charge by hand</summary><form class="form two" method="post" action="/ui/statements">${fields(
          {},
          `<label>Invoice number (optional)<input name="reference" maxlength="80" autocomplete="off"></label>`,
        )}<div class="actions"><button type="submit" class="primary">Add</button></div></form></details>`,
      }),
    );

  parts.push(
    card({
      title: "Spend ceilings at the vendors",
      flush: true,
      body: rowList(
        Object.entries(c.ceilings).map(([name, v]) =>
          item({
            title: `<strong title="${esc(name)}">${esc(v.label)}</strong>`,
            lines: [`<span title="${esc(v.where)}">${esc(v.where)}</span>`],
            end:
              v.value === "unknown"
                ? `<span class="warn">unknown</span>`
                : `<strong>${esc(v.value)}</strong>`,
          }),
        ),
      ),
    }),
  );

  return layout(view, { section: "cost", flash, body: parts.join("\n") });
}
