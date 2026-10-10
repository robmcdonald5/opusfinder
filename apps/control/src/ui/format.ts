/** Everything a page prints goes through `esc`: reasons, notes and run details are written by agents and runtimes, so they are untrusted. */

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthAbbr(mm: string): string {
  return MONTHS[Number(mm) - 1] ?? mm;
}

export function stamp(iso: string): string {
  return `${monthAbbr(iso.slice(5, 7))} ${Number(iso.slice(8, 10))}, ${iso.slice(11, 16)}`;
}

/** Times are UTC (the sidebar says so); the full time is the hover text. */
export function ts(iso: string | null | undefined, nowIso: string): string {
  if (!iso) return "";
  const short =
    iso.slice(0, 10) === nowIso.slice(0, 10)
      ? iso.slice(11, 16)
      : iso.slice(0, 4) === nowIso.slice(0, 4)
        ? stamp(iso)
        : iso.slice(0, 10);
  return `<time class="muted nowrap" datetime="${esc(iso)}" title="${esc(
    `${iso.slice(0, 16).replace("T", " ")} UTC`,
  )}">${esc(short)}</time>`;
}

export function day(d: string | null | undefined, nowIso: string): string {
  if (!d) return "";
  return esc(
    d.slice(0, 4) === nowIso.slice(0, 4)
      ? `${monthAbbr(d.slice(5, 7))} ${Number(d.slice(8, 10))}`
      : d,
  );
}

export function monthShort(ym: string | null | undefined, nowIso: string): string {
  if (!ym) return "";
  const name = monthAbbr(ym.slice(5, 7));
  return esc(ym.slice(0, 4) === nowIso.slice(0, 4) ? name : `${name} ${ym.slice(0, 4)}`);
}

export function ago(iso: string | null | undefined, nowIso: string): string {
  if (!iso) return "";
  const diff = Date.parse(nowIso) - Date.parse(iso);
  if (!Number.isFinite(diff)) return "";
  const mins = Math.round(Math.abs(diff) / 60_000);
  const span =
    mins < 1
      ? "under a minute"
      : mins < 90
        ? `${mins} min`
        : mins < 36 * 60
          ? `${Math.round(mins / 60)} h`
          : `${Math.round(mins / 1440)} d`;
  return diff >= 0 ? `${span} ago` : `in ${span}`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function period(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

export function num(n: number): string {
  return n.toLocaleString("en-US");
}

export function compact(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    n,
  );
}

export function usd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

/** The last day of a YYYY-MM month. */
export function monthEnd(month: string): string {
  return new Date(Date.parse(`${shiftMonth(month, 1)}-01T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** "October 2026", "Aug – Oct 2026" or "Dec 2025 – Feb 2026". */
export function monthSpan(from: string, to: string): string {
  if (from === to) return monthName(from);
  const short = (ym: string) => monthAbbr(ym.slice(5, 7));
  return from.slice(0, 4) === to.slice(0, 4)
    ? `${short(from)} – ${short(to)} ${to.slice(0, 4)}`
    : `${short(from)} ${from.slice(0, 4)} – ${short(to)} ${to.slice(0, 4)}`;
}

export function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

export function tally(values: readonly string[], order: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return order
    .filter((v) => (counts.get(v) ?? 0) > 0)
    .map((v) => `${counts.get(v)} ${v}`)
    .join(" · ");
}
