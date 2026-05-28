/**
 * The committed metrics snapshot and its human-readable formatting (Phase 5). One report
 * file per ranker configuration is the BASELINE; the next run diffs against it and prints
 * the per-k deltas, so any prompt / model / embedding change shows up as a metric movement.
 *
 * The persisted shape is deliberately DETERMINISTIC — no timestamp — so re-running with
 * unchanged metrics produces a byte-identical file (clean snapshot semantics, no git churn).
 * Paths are stored relative-to-package with forward slashes, so the file is identical across
 * machines / OSes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isRecord } from "@opusfinder/shared";

import type { AggregateMetrics } from "./metrics";

export interface EvalReport {
  ranker: string;
  /** Embedding provider when the ranker is embedding-based, else null. */
  embedder: string | null;
  dataset: string;
  exampleCount: number;
  metrics: AggregateMetrics[];
}

/**
 * Read a committed report, or null when there's no usable baseline to diff against — the file is
 * missing, unparseable, OR structurally wrong (hand-edited / partially written / schema drift).
 * Returning null degrades to "establish a new baseline" instead of letting diffReports throw on a
 * malformed prev. JSON has no NaN literal, so writeReport serialized any NaN metric as `null`;
 * coerceReport maps it back to NaN so ppDelta's Number.isNaN guards fire — otherwise null coerces
 * to 0 and fabricates a delta exactly when a metric is undefined.
 */
export function readReport(path: string): EvalReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return coerceReport(parsed);
}

/** JSON null is a serialized NaN (JSON has no NaN literal); map it — and any non-number — to NaN. */
const numOrNaN = (v: unknown): number => (typeof v === "number" ? v : NaN);

/**
 * Validate the persisted shape and normalize metric values, or null if it isn't a report with a
 * `metrics` array of `{ k, ... }` entries. Only `metrics` is load-bearing for diffReports; the
 * other fields are passed through best-effort so a slightly-off file still diffs rather than crashes.
 */
function coerceReport(parsed: unknown): EvalReport | null {
  if (!isRecord(parsed) || !Array.isArray(parsed.metrics)) return null;
  const metrics: AggregateMetrics[] = [];
  for (const m of parsed.metrics) {
    if (!isRecord(m) || typeof m.k !== "number") return null;
    const counts = isRecord(m.counts) ? m.counts : ({} as Record<string, unknown>);
    metrics.push({
      k: m.k,
      precision: numOrNaN(m.precision),
      recall: numOrNaN(m.recall),
      ndcg: numOrNaN(m.ndcg),
      counts: {
        precision: numOrNaN(counts.precision),
        recall: numOrNaN(counts.recall),
        ndcg: numOrNaN(counts.ndcg),
      },
    });
  }
  return {
    ranker: typeof parsed.ranker === "string" ? parsed.ranker : "",
    embedder: typeof parsed.embedder === "string" ? parsed.embedder : null,
    dataset: typeof parsed.dataset === "string" ? parsed.dataset : "",
    exampleCount: numOrNaN(parsed.exampleCount),
    metrics,
  };
}

/** Write a report as pretty JSON (creating the reports dir as needed). */
export function writeReport(path: string, report: EvalReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/** A metric as a right-aligned percentage (with its "%"), or "n/a" when undefined (NaN). The "%"
 * lives inside so the undefined case is a clean "n/a", never the nonsensical "n/a%". */
const pct = (x: number): string =>
  Number.isNaN(x) ? "n/a".padStart(6) : `${(x * 100).toFixed(1)}%`.padStart(6);

/** A fixed-width table of precision / recall / ndcg per k. */
export function formatReport(r: EvalReport): string {
  const head =
    `ranker=${r.ranker}${r.embedder ? ` embedder=${r.embedder}` : ""}` +
    `  examples=${r.exampleCount}  dataset=${r.dataset}`;
  const rows = r.metrics.map(
    (m) =>
      `  @${String(m.k).padEnd(2)}  P ${pct(m.precision)}  R ${pct(m.recall)}  NDCG ${pct(m.ndcg)}`,
  );
  return [head, ...rows].join("\n");
}

/**
 * One per-k delta cell, in percentage points, right-padded to 8 (fits a full ±100.0pp swing).
 * `(b - a) * 100`, signed, one
 * decimal. A value rounding to zero prints "0.0pp" with no sign — never a misleading "-0.0pp"
 * for floating-point noise between two equal runs. One side NaN (a metric undefined in only one
 * run) → "n/a"; BOTH NaN → `bothUndefined` (the single-ranker diff shows "=", the head-to-head
 * "n/a"). Shared by `diffReports` here and `compare.ts`'s head-to-head so the two can't drift.
 */
export function ppDelta(a: number, b: number, bothUndefined = "n/a"): string {
  if (Number.isNaN(a) && Number.isNaN(b)) return bothUndefined.padStart(8);
  if (Number.isNaN(a) || Number.isNaN(b)) return "n/a".padStart(8);
  const d = (b - a) * 100;
  const fixed = d.toFixed(1);
  const cell = Number(fixed) === 0 ? "0.0pp" : `${d > 0 ? "+" : ""}${fixed}pp`;
  return cell.padStart(8);
}

/** Per-k delta of `next` vs `prev` in percentage points; `=` when both are undefined. */
export function diffReports(prev: EvalReport | null, next: EvalReport): string {
  if (!prev) return "  (no previous report — this run establishes the baseline)";
  const byK = new Map(prev.metrics.map((m) => [m.k, m]));
  return next.metrics
    .map((m) => {
      const p = byK.get(m.k);
      if (!p) return `  @${m.k}  (new k)`;
      return `  @${String(m.k).padEnd(2)}  P ${ppDelta(p.precision, m.precision, "=")}  R ${ppDelta(p.recall, m.recall, "=")}  NDCG ${ppDelta(p.ndcg, m.ndcg, "=")}`;
    })
    .join("\n");
}
