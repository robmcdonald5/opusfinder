import { esc } from "./format";

/** Building blocks that return markup. Parameters take markup the caller already escaped, unless one says plain text. */

export function icon(inner: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

/** `title` is plain text (escaped here); `titleHtml` is markup the caller built from escaped parts. */
export function card(opts: {
  title?: string;
  titleHtml?: string;
  aside?: string;
  body: string;
  foot?: string;
  id?: string;
  flush?: boolean;
}): string {
  const title = opts.titleHtml ?? (opts.title !== undefined ? esc(opts.title) : "");
  const head =
    title || opts.aside
      ? `<header class="card-h"><h2>${title}</h2>${opts.aside ? `<div>${opts.aside}</div>` : ""}</header>`
      : "";
  const body = opts.flush ? opts.body : `<div class="card-b">${opts.body}</div>`;
  const foot = opts.foot ? `<div class="card-f">${opts.foot}</div>` : "";
  return `<section class="card"${opts.id ? ` id="${esc(opts.id)}"` : ""}>${head}${body}${foot}</section>`;
}

export function fold(o: { title: string; aside?: string; body: string; foot?: string }): string {
  return `<details class="card fold"><summary class="card-h"><h2>${esc(o.title)}</h2>${
    o.aside ? `<div>${o.aside}</div>` : ""
  }</summary>${o.body}${o.foot ? `<div class="card-f">${o.foot}</div>` : ""}</details>`;
}

/** One list row. On a phone `end` stays beside the title and the change button drops below it. */
export function item(o: {
  title: string;
  body?: string;
  lines?: readonly string[];
  end?: string;
  change?: Change | false | null;
  id?: string;
  nested?: string;
  cls?: string;
}): string {
  const lines = (o.lines ?? []).filter(Boolean);
  const sub =
    o.body || lines.length > 0
      ? `<div class="sub">${o.body ? `<div class="b">${o.body}</div>` : ""}${lines
          .map((l) => `<div class="m">${l}</div>`)
          .join("")}</div>`
      : "";
  const cls = ["item", sub ? "" : "solo", o.change ? "" : "noact", o.cls ?? ""]
    .filter(Boolean)
    .join(" ");
  // The button stays in the row; what it opens is a sibling panel the stylesheet shows while it's open.
  const act = o.change
    ? `<div class="act"><details class="change"><summary>${esc(o.change.label)}</summary></details></div><div class="panel">${o.change.body}</div>`
    : "";
  return `<li class="${cls}"${o.id ? ` id="${esc(o.id)}"` : ""}><div class="t">${o.title}</div>${
    o.end ? `<div class="end">${o.end}</div>` : ""
  }${sub}${act}${o.nested ? `<ul class="rows nest">${o.nested}</ul>` : ""}</li>`;
}

export function tabs(items: readonly { href: string; label: string; current: boolean }[]): string {
  return `<nav class="tabs" aria-label="Views">${items
    .map(
      (t) =>
        `<a href="${esc(t.href)}"${t.current ? ' aria-current="page"' : ""}>${esc(t.label)}</a>`,
    )
    .join("")}</nav>`;
}

export interface Change {
  label: string;
  body: string;
}

/**
 * On a phone rows stack (`labelled` labels each cell). The `fill` column takes the spare width, so its long
 * text ends in "…" instead of widening the table.
 */
export function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  opts: {
    num?: readonly number[];
    fill?: number;
    labelled?: boolean;
    rowClass?: (i: number) => string;
  } = {},
): string {
  const cls = (i: number) =>
    opts.num?.includes(i) ? ' class="num"' : opts.fill === i ? ' class="fill"' : "";
  return `<div class="scroll"><table class="stack${opts.labelled ? " labelled" : ""}"><thead><tr>${headers
    .map((h, i) => `<th${cls(i)}>${esc(h)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map((r, n) => {
      const rc = opts.rowClass?.(n);
      return `<tr${rc ? ` class="${esc(rc)}"` : ""}>${r
        .map((c, i) => `<td${cls(i)} data-label="${esc(headers[i] ?? "")}">${c}</td>`)
        .join("")}</tr>`;
    })
    .join("")}</tbody></table></div>`;
}

export function stat(
  label: string,
  v: string,
  sub: string,
  opts: { href?: string; tone?: "warn" | "bad"; meter?: string } = {},
): string {
  const inner = `<span class="l">${esc(label)}</span><span class="v${opts.tone ? ` ${opts.tone}` : ""}">${v}</span>${
    opts.meter ?? ""
  }${sub ? `<span class="s">${sub}</span>` : ""}`;
  return opts.href
    ? `<a class="stat" href="${esc(opts.href)}">${inner}</a>`
    : `<div class="stat">${inner}</div>`;
}

export function level(value: number, limit: number): "warn" | "bad" | undefined {
  if (!(limit > 0)) return undefined;
  return value > limit ? "bad" : value >= limit * 0.8 ? "warn" : undefined;
}

export function meter(value: number, limit: number): string {
  if (!(limit > 0)) return "";
  const pct = Math.round((value / limit) * 100);
  const tone = level(value, limit);
  return `<span class="meter${tone ? ` ${tone}` : ""}" role="img" aria-label="${pct}% of the limit"><span style="width:${Math.min(
    100,
    Math.max(0, pct),
  )}%"></span></span>`;
}

export function empty(text: string): string {
  return `<p class="empty">${esc(text)}</p>`;
}

const CLIP_AT = 48;

/**
 * Long free text as one line ending in "…" that opens on a click (a <details> whose summary unclips, no
 * script). Short text stays plain.
 */
export function clip(text: string | null | undefined, cls = ""): string {
  const t = text ?? "";
  const c = cls ? ` class="${cls}"` : "";
  if (t.length <= CLIP_AT) return `<span${c}>${esc(t)}</span>`;
  return `<details class="clip${cls ? ` ${cls}` : ""}"><summary title="${esc(t)}">${esc(t)}</summary></details>`;
}

export function filterSelect(
  name: string,
  label: string,
  values: readonly string[],
  current: string,
): string {
  return `<label>${esc(label)}<select name="${esc(name)}"><option value="">all</option>${values
    .map((v) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(v)}</option>`)
    .join("")}</select></label>`;
}

/** Feather icon (MIT). */
export const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

export function rowList(rows: readonly string[], emptyText?: string): string {
  if (rows.length > 0) return `<ul class="rows">${rows.join("")}</ul>`;
  return emptyText ? empty(emptyText) : "";
}

/** The period picker every filtered page uses: two calendar fields, inclusive days. */
export function periodFields(from: string, to: string): string[] {
  return [
    `<label>From<input type="date" name="from" value="${esc(from)}"></label>`,
    `<label>To<input type="date" name="to" value="${esc(to)}"></label>`,
  ];
}

export function filterForm(action: string, selects: readonly string[]): string {
  return `<form class="filters" method="get" action="${esc(action)}">${selects.join(
    "",
  )}<button type="submit">Show</button></form>`;
}

export function facts(pairs: readonly (readonly [string, string])[]): string {
  return `<dl class="kv">${pairs
    .filter(([, dd]) => dd)
    .map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${dd}</dd>`)
    .join("")}</dl>`;
}

/**
 * The row for every switch and setting, so they all read and line up alike: the name on the left, the value
 * (or the owner's control for it) on the right. A switch's own settings sit indented under it, one row each.
 * `name` is plain text. `idle` greys the names (a health check whose watched stage is off).
 */
export function controlRow(o: {
  name: string;
  hover?: string;
  href?: string;
  id?: string;
  lines?: readonly string[];
  value: string;
  settings?: readonly string[];
  idle?: boolean;
}): string {
  const tip = o.hover ? ` title="${esc(o.hover)}"` : "";
  const title = o.href
    ? `<a href="${esc(o.href)}"${tip}><strong>${esc(o.name)}</strong></a>`
    : `<strong${tip}>${esc(o.name)}</strong>`;
  return item({
    title,
    end: o.value,
    ...(o.id ? { id: o.id } : {}),
    ...(o.lines ? { lines: o.lines } : {}),
    ...(o.settings?.length ? { nested: o.settings.join("") } : {}),
    cls: o.idle ? "ctl idle" : "ctl",
  });
}

/** A band heading the rows after it in a `rowList`; `title` and `end` are markup. */
export function groupRow(title: string, end: string): string {
  return `<li class="grp"><span>${title}</span>${end}</li>`;
}
