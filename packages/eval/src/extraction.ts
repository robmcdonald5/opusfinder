/**
 * Phase-F4 extraction-accuracy eval — a THIN SIBLING of the ranking harness, NOT a `Ranker` (the Ranker
 * contract returns a permutation of candidate ids and structurally cannot express a per-row
 * `{title,description} → {yoeBand, salary}` correctness judgment; see PHASE_F4_PLAN.md decision 9). Same
 * package + conventions as the ranking harness — JSONL fixtures validated at load with line numbers, a
 * byte-deterministic (no-timestamp) report, a keyless deterministic stub default with a live-key opt-in — but
 * a DIFFERENT mechanism: a per-field CONFUSION MATRIX. The load-bearing cell is **hallucinated-when-absent**
 * (expected null, predicted non-null): a deterministic filter trusts these columns literally, so that
 * false-positive rate is what gates the F4-FILTER follow-on.
 */
import { readFileSync } from "node:fs";

import { type JobEnrichment, type SalaryPeriod, SALARY_PERIODS, isRecord } from "@opusfinder/shared";

import { hashString, mulberry32 } from "./rng";

/** One hand-labeled fixture: a real job's prose + the gold enrichment the owner ratified from it. */
export interface ExtractionFixture {
  jobId: number;
  title: string;
  description: string;
  expected: JobEnrichment;
  notes?: string;
}

/** A job extractor under test — the same shape production runs (`makeJobEnrichmentExtractor`'s return). */
export type JobExtractor = (job: { title: string; descriptionText: string }) => Promise<JobEnrichment>;

/** The six enrichment fields, in a FIXED order so the report is byte-stable. */
const FIELDS = [
  "yoeMin",
  "yoeMax",
  "salaryMin",
  "salaryMax",
  "salaryCurrency",
  "salaryPeriod",
] as const satisfies readonly (keyof JobEnrichment)[];

// ─── Fixture loading + validation (mirrors dataset.ts: JSONL, skip blank/comment lines, throw with a
//     line number so a hand-labeling mistake fails loudly at the boundary, not as a silently-wrong score) ──

/** Read a JSONL fixtures file and return validated fixtures. */
export function loadFixtures(path: string): ExtractionFixture[] {
  return parseFixtureLines(readFileSync(path, "utf8"), path);
}

/** Parse + validate a JSONL string (separated from I/O so it is unit-testable on inline strings). */
export function parseFixtureLines(text: string, label = "fixtures"): ExtractionFixture[] {
  const out: ExtractionFixture[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("#")) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${label}:${i + 1}: invalid JSON — ${msg}`, { cause: err });
    }
    out.push(validateFixture(parsed, `${label}:${i + 1}`));
  });
  return out;
}

/** A nullable NON-NEGATIVE integer field (yoe / salary): null, or an integer >= 0. Rejecting negatives keeps
 *  the gold aligned with the production schema (job-enrich.ts enforces `.min(0)`), so a labeling sign-flip
 *  fails LOUDLY here instead of scoring a permanent wrongValue the extractor structurally cannot match. */
function intOrNull(value: unknown, at: string, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${at}: expected.${field} must be an integer or null.`);
  }
  if (value < 0) throw new Error(`${at}: expected.${field} must be >= 0 (got ${value}).`);
  return value;
}

/** Reject an inverted band (min > max) when BOTH bounds are stated — a one-sided band (one null) is legal. */
function assertBand(min: number | null, max: number | null, at: string, name: string): void {
  if (min !== null && max !== null && min > max) {
    throw new Error(`${at}: expected.${name} band is inverted (min ${min} > max ${max}).`);
  }
}

function validateFixture(value: unknown, at: string): ExtractionFixture {
  if (!isRecord(value)) throw new Error(`${at}: expected an object.`);
  if (typeof value.jobId !== "number" || !Number.isInteger(value.jobId)) {
    throw new Error(`${at}: jobId must be an integer.`);
  }
  if (typeof value.title !== "string") throw new Error(`${at}: title must be a string.`);
  if (typeof value.description !== "string") throw new Error(`${at}: description must be a string.`);
  if (value.title.trim() === "" && value.description.trim() === "") {
    throw new Error(`${at}: title and description are both empty (no extractable content).`);
  }
  if (!isRecord(value.expected)) throw new Error(`${at}: expected must be an object.`);
  const e = value.expected;

  let salaryCurrency: string | null;
  if (e.salaryCurrency === null) salaryCurrency = null;
  else if (typeof e.salaryCurrency === "string") salaryCurrency = e.salaryCurrency;
  else throw new Error(`${at}: expected.salaryCurrency must be a string or null.`);

  let salaryPeriod: SalaryPeriod | null;
  if (e.salaryPeriod === null) salaryPeriod = null;
  else if (typeof e.salaryPeriod === "string" && (SALARY_PERIODS as readonly string[]).includes(e.salaryPeriod)) {
    salaryPeriod = e.salaryPeriod as SalaryPeriod;
  } else {
    throw new Error(`${at}: expected.salaryPeriod must be one of ${SALARY_PERIODS.join("|")} or null.`);
  }

  const expected: JobEnrichment = {
    yoeMin: intOrNull(e.yoeMin, at, "yoeMin"),
    yoeMax: intOrNull(e.yoeMax, at, "yoeMax"),
    salaryMin: intOrNull(e.salaryMin, at, "salaryMin"),
    salaryMax: intOrNull(e.salaryMax, at, "salaryMax"),
    salaryCurrency,
    salaryPeriod,
  };
  assertBand(expected.yoeMin, expected.yoeMax, at, "yoe");
  assertBand(expected.salaryMin, expected.salaryMax, at, "salary");

  const fixture: ExtractionFixture = {
    jobId: value.jobId,
    title: value.title,
    description: value.description,
    expected,
  };
  if (value.notes !== undefined) {
    if (typeof value.notes !== "string") throw new Error(`${at}: notes must be a string.`);
    fixture.notes = value.notes;
  }
  return fixture;
}

// ─── Scoring: the per-field confusion matrix ─────────────────────────────────────────────────────────────

/** The five mutually-exclusive outcomes for one (expected, predicted) field pair. */
export interface FieldConfusion {
  field: string;
  /** expected null, predicted null — true negative (correctly declined to guess). */
  correctNull: number;
  /** expected NON-null, predicted equal — true positive. */
  correctValue: number;
  /** expected NON-null, predicted a DIFFERENT non-null value. */
  wrongValue: number;
  /** expected NON-null, predicted null — missed (false negative). */
  missed: number;
  /** expected null, predicted NON-null — HALLUCINATED (false positive). The F4-FILTER enforce gate. */
  hallucinated: number;
  /** Count of fixtures where expected is null (the hallucination-rate denominator). */
  absent: number;
  /** Count of fixtures where expected is non-null (the present-accuracy denominator). */
  present: number;
}

export interface ExtractionReport {
  extractor: string;
  dataset: string;
  fixtureCount: number;
  fields: FieldConfusion[];
}

/** Score a set of predictions (aligned 1:1 with `fixtures`) into a per-field confusion matrix. */
export function scoreExtraction(
  extractor: string,
  dataset: string,
  fixtures: ExtractionFixture[],
  predictions: JobEnrichment[],
): ExtractionReport {
  if (predictions.length !== fixtures.length) {
    throw new Error(
      `scoreExtraction: ${predictions.length} predictions for ${fixtures.length} fixtures.`,
    );
  }
  const fields: FieldConfusion[] = FIELDS.map((field) => {
    const c: FieldConfusion = {
      field,
      correctNull: 0,
      correctValue: 0,
      wrongValue: 0,
      missed: 0,
      hallucinated: 0,
      absent: 0,
      present: 0,
    };
    fixtures.forEach((fx, i) => {
      const exp = fx.expected[field];
      const pred = predictions[i]![field];
      if (exp === null) {
        c.absent++;
        if (pred === null) c.correctNull++;
        else c.hallucinated++;
      } else {
        c.present++;
        if (pred === null) c.missed++;
        else if (pred === exp) c.correctValue++;
        else c.wrongValue++;
      }
    });
    return c;
  });
  return { extractor, dataset, fixtureCount: fixtures.length, fields };
}

/** Hallucinated / absent — the false-positive rate a deterministic filter would inherit. NaN when no
 *  fixture has this field absent (nothing to hallucinate against). */
export function hallucinationRate(c: FieldConfusion): number {
  return c.absent === 0 ? NaN : c.hallucinated / c.absent;
}

/** correctValue / present — accuracy when the field IS stated. NaN when no fixture has it present. */
export function presentAccuracy(c: FieldConfusion): number {
  return c.present === 0 ? NaN : c.correctValue / c.present;
}

const pctOrNa = (x: number): string => (Number.isNaN(x) ? "  n/a" : `${(x * 100).toFixed(1)}%`.padStart(6));

/** A fixed-width, byte-deterministic table: per field the five cells + the two rates. */
export function formatExtractionReport(r: ExtractionReport): string {
  const head = `extractor=${r.extractor}  fixtures=${r.fixtureCount}  dataset=${r.dataset}`;
  const cols = "  field           correctNull correctVal wrongVal missed HALLUC  hallucRate presentAcc";
  const rows = r.fields.map((c) => {
    const cell = (n: number) => String(n).padStart(4);
    return (
      `  ${c.field.padEnd(15)}${cell(c.correctNull)}     ${cell(c.correctValue)}     ` +
      `${cell(c.wrongValue)}   ${cell(c.missed)}  ${cell(c.hallucinated)}    ` +
      `${pctOrNa(hallucinationRate(c))}     ${pctOrNa(presentAccuracy(c))}`
    );
  });
  return [head, cols, ...rows].join("\n");
}

// ─── The keyless deterministic stub extractor (default, byte-stable report, no API key) ───────────────────

/**
 * A deterministic stand-in for the real extractor (the `stubRerankCall` pattern): per field, a stable hash of
 * (title, field) decides null vs a hashed in-range value, so the committed stub report is byte-stable and
 * exercises ALL FIVE confusion cells without a network call. NOT a quality signal — it proves the loader +
 * scorer + report wiring. Real accuracy comes from the `--live` pass (the injected Haiku extractor).
 * Its per-field values are independent draws, so it does NOT honor the live extractor's cross-field invariants
 * (min <= max, salary fields move together) — irrelevant for wiring-proof, and its report is gitignored.
 */
export const stubExtract: JobExtractor = (job) => {
  const r = (salt: string): number => mulberry32((hashString(job.title + salt) >>> 0) || 1)();
  const orNull = <T>(salt: string, value: T): T | null => (r(salt) < 0.5 ? null : value);
  const period = SALARY_PERIODS[Math.floor(r("periodPick") * SALARY_PERIODS.length)] ?? "year";
  return Promise.resolve({
    yoeMin: orNull("yoeMin", Math.floor(r("yoeMinV") * 11)),
    yoeMax: orNull("yoeMax", Math.floor(r("yoeMaxV") * 11) + 5),
    salaryMin: orNull("salMin", Math.floor(r("salMinV") * 100_000) + 40_000),
    salaryMax: orNull("salMax", Math.floor(r("salMaxV") * 100_000) + 80_000),
    salaryCurrency: orNull("cur", "USD"),
    salaryPeriod: orNull("period", period),
  });
};
