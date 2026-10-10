import type { CostView, StatementView, StatusView } from "../service";
import { GMAIL_LINK, STATEMENT_KINDS, isConfirmationRow, isGmailConfirmation } from "../statements";
import { esc, isOwner, layout, mode, when } from "./html";

/**
 * Cost: what each vendor actually charged, from the invoices forwarded to the billing address (owner
 * decision 2026-10-10: statements, not a maintained price table). Amounts are US cents in the data.
 */

export function usd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function from(s: StatementView): string {
  if (s.source === "manual") return `<span class="muted">entered by ${esc(s.updated_by)}</span>`;
  return `<span class="muted">${esc(s.sender ?? "unknown sender")}${s.subject ? ` · ${esc(s.subject)}` : ""}</span>`;
}

/** The owner's fields for one charge: shared by "count it", "change" and "add by hand". */
function fields(s: Partial<StatementView>, extra = ""): string {
  const kind = s.kind ?? "other";
  return `<label>Vendor<input name="vendor" required maxlength="80" autocomplete="off" value="${esc(s.vendor ?? "")}"></label>
<label>Amount (USD)<input name="amount" type="number" inputmode="decimal" min="0" step="0.01" required value="${
    s.amount_cents !== null && s.amount_cents !== undefined
      ? esc((s.amount_cents / 100).toFixed(2))
      : ""
  }"></label>
<label>Charged on<input name="chargedOn" type="date" required value="${esc(s.charged_on ?? "")}"></label>
<label>Service period starts (optional; files a usage charge under that month)<input name="periodStart" type="date" value="${esc(
    s.period_start ?? "",
  )}"></label>
<label>Kind<select name="kind">${STATEMENT_KINDS.map(
    (k) => `<option value="${k}"${k === kind ? " selected" : ""}>${k}</option>`,
  ).join("")}</select></label>${extra}
<label>Note (optional)<input name="note" maxlength="300" autocomplete="off"></label>`;
}

function decideForm(s: StatementView, summary: string): string {
  return `<details class="change"><summary>${esc(summary)}</summary><form class="form" method="post" action="/ui/statements/${esc(
    s.id,
  )}">${fields(s)}<div class="actions"><button type="submit" name="action" value="count">Count it</button><button type="submit" name="action" value="exclude" class="reject" formnovalidate>Don&#39;t count</button></div></form></details>`;
}

function statementLine(s: StatementView): string {
  return `${s.vendor ? `<strong>${esc(s.vendor)}</strong> ` : ""}${usd(s.amount_cents)}${
    s.currency && s.currency !== "USD" ? ` ${esc(s.currency)}` : ""
  } <span class="muted">${esc(s.kind)}${s.charged_on ? ` · charged ${esc(s.charged_on)}` : ""}${
    s.period_start ? ` · for the period from ${esc(s.period_start)}` : ""
  }${s.reference ? ` · #${esc(s.reference)}` : ""}</span>`;
}

/** Gmail's forwarding confirmation link, clickable for the owner (only a Google mail-settings URL). */
function confirmLink(s: StatementView): string {
  if (!isGmailConfirmation(s.sender)) return "";
  const link = GMAIL_LINK.exec(s.note ?? "")?.[0];
  return link
    ? `<br><a href="${esc(link)}" rel="noreferrer noopener" target="_blank">Open Gmail's confirmation link</a>`
    : "";
}

export function renderCost(view: StatusView, c: CostView, flash: string | null): string {
  const owner = isOwner(view);
  const parts: string[] = [];
  const byMonth = new Map(c.months.map((m) => [m.month, m]));
  const current = byMonth.get(c.currentMonth);
  const last = byMonth.get(shiftMonth(c.currentMonth, -1));
  const targetCents = c.targetUsdPerMonth * 100;
  const count = current ? current.vendors.reduce((n, v) => n + v.n, 0) : 0;
  const address = c.billingAddress
    ? `<code>${esc(c.billingAddress)}</code>`
    : "the billing address";

  parts.push(`<p class="muted">What each vendor actually charged, read from the invoices forwarded to ${address}. A charge is filed under the month its service period covers when the invoice says so, else the month it was charged; prepaid credits count when bought.</p>
<div class="stats">
<div class="stat"><span class="muted">${esc(monthName(c.currentMonth))} so far</span><span class="v${
    current && current.cents > targetCents ? " bad" : ""
  }">${usd(current?.cents ?? 0)}</span><span class="muted">${count} statement${count === 1 ? "" : "s"}</span></div>
<div class="stat"><span class="muted">${esc(monthName(shiftMonth(c.currentMonth, -1)))}</span><span class="v">${usd(
    last?.cents ?? 0,
  )}</span></div>
<div class="stat"><span class="muted">Target (advisory)</span><span class="v">${usd(targetCents)}</span><span class="muted">a month</span></div>
</div>`);

  if (c.months.length === 0 && c.reviewCount === 0)
    parts.push(
      `<p class="note">Nothing recorded yet. Once ${address} reaches this Worker, each forwarded invoice shows up here within a minute. For older invoices, forward them by hand or add them below.</p>`,
    );

  // ---- the owner's queue ----
  if (c.reviewCount > 0) {
    parts.push(
      `<h2>Needs your review (${c.reviewCount})</h2>${
        c.reviewCount > c.review.length
          ? `<p class="muted">Showing the newest ${c.review.length}.</p>`
          : ""
      }`,
    );
    for (const s of c.review) {
      parts.push(
        `<div class="card"><p>${statementLine(s)}</p><p>${from(s)} ${when(s.received_at)}</p>${
          s.note ? `<p class="warn">${esc(s.note)}</p>` : ""
        }${owner ? decideForm(s, "Count it or don't") : ""}</div>`,
      );
    }
  }

  // ---- by month ----
  parts.push(`<h2>By month</h2>`);
  if (c.months.length === 0) parts.push(`<p class="muted">No recorded statements yet.</p>`);
  else
    parts.push(
      `<div class="scroll"><table class="stack"><thead><tr><th>Month</th><th>Total</th><th>Vendors</th></tr></thead><tbody>${c.months
        .map(
          (m) =>
            `<tr><td><a href="/cost?month=${esc(m.month)}">${esc(monthName(m.month))}</a></td><td${
              m.cents > targetCents ? ' class="bad"' : ""
            }>${usd(m.cents)}</td><td class="muted">${m.vendors
              .map((v) => `${esc(v.vendor)} ${usd(v.cents)}`)
              .join(" · ")}</td></tr>`,
        )
        .join("")}</tbody></table></div>`,
    );

  // ---- one month's statements ----
  const prev = shiftMonth(c.month, -1);
  const next = shiftMonth(c.month, 1);
  parts.push(`<h2 id="month">${esc(monthName(c.month))}</h2>
<p><a href="/cost?month=${esc(prev)}#month">← ${esc(monthName(prev))}</a>${
    c.month < c.currentMonth
      ? ` · <a href="/cost?month=${esc(next)}#month">${esc(monthName(next))} →</a>`
      : ""
  }</p>`);
  if (c.statements.length === 0)
    parts.push(`<p class="muted">No recorded statements this month.</p>`);
  else
    parts.push(
      `<ul class="rows">${c.statements
        .map(
          (s) =>
            `<li>${statementLine(s)}<br>${from(s)}${
              s.note ? `<br><span class="muted">${esc(s.note)}</span>` : ""
            }${owner ? decideForm(s, "Change") : ""}</li>`,
        )
        .join("")}</ul>`,
    );

  // ---- what isn't counted ----
  if (c.notCounted.length > 0)
    parts.push(
      `<details><summary class="muted">Not counted (${c.notCounted.length} most recent): duplicates, excluded, and Gmail&#39;s confirmations</summary><ul class="rows">${c.notCounted
        .map(
          (s) =>
            `<li>${mode(s.status)} ${statementLine(s)}<br>${from(s)} ${when(s.received_at)}${
              s.note ? `<br><span class="muted">${esc(s.note)}</span>` : ""
            }${owner ? confirmLink(s) : ""}${
              owner && !isConfirmationRow(s) ? decideForm(s, "Count it") : ""
            }</li>`,
        )
        .join("")}</ul></details>`,
    );

  if (owner)
    parts.push(`<h2>Add a statement by hand</h2><p class="muted">For history from before the mailbox, or a vendor that doesn&#39;t email an invoice.</p>
<details class="change"><summary>Add</summary><form class="form" method="post" action="/ui/statements">${fields(
      {},
      `<label>Invoice number (optional)<input name="reference" maxlength="80" autocomplete="off"></label>`,
    )}<button type="submit">Add</button></form></details>`);

  parts.push(
    `<h2>Spend ceilings at the vendors</h2><p class="muted">The last line of defence, set in each vendor&#39;s console; listed here so they're set on purpose.</p><ul class="rows">${Object.entries(
      c.ceilings,
    )
      .map(
        ([name, v]) =>
          `<li><code>${esc(name)}</code>: <strong>${esc(v.value)}</strong> <span class="muted">· ${esc(v.where)}</span></li>`,
      )
      .join("")}</ul>`,
  );

  return layout(view, { section: "cost", title: "Cost", flash, body: parts.join("\n") });
}
