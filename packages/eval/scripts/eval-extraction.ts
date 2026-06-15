/**
 * Phase-F4 extraction-accuracy eval runner (4e). Runs a job extractor over the hand-labeled fixtures and
 * prints a per-field CONFUSION MATRIX — the make-or-break number being the **hallucinated-when-absent** rate
 * (expected null, predicted non-null), since a deterministic F4-FILTER trusts these columns literally. This
 * eval PASSING is the precondition before any F4-FILTER salary/YoE predicate may leave `off`; it is distinct
 * from `pnpm eval` (the ranking no-regression guard, which can't measure extraction).
 *
 *   pnpm eval:extraction                                  # keyless: deterministic stub, byte-stable report
 *   pnpm eval:extraction -- --live                        # real Haiku extractor (needs ANTHROPIC_API_KEY)
 *   pnpm eval:extraction -- --live --model sonnet         # the F4-MODEL accuracy spot-check
 *   pnpm eval:extraction -- --dataset data/other.jsonl    # a different fixtures file
 *
 * The `--` is required so the root wrapper forwards the flags. Keyless is the default so the harness runs in
 * CI with no creds; the stub is NOT a quality signal (it proves the loader + scorer + report). Real accuracy
 * comes from `--live`. The committed stub report is byte-deterministic (no timestamp).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { JobEnrichment } from "@opusfinder/shared";
import { runScript } from "@opusfinder/shared/script";

import { getFlag } from "../src/cli";
import {
  type ExtractionReport,
  type JobExtractor,
  formatExtractionReport,
  hallucinationRate,
  loadFixtures,
  scoreExtraction,
  stubExtract,
} from "../src/extraction";
import { PKG_ROOT, relativeToPkg } from "../src/runner";

async function resolveExtractor(
  live: boolean,
  model: string,
): Promise<{ extract: JobExtractor; label: string }> {
  if (!live) return { extract: stubExtract, label: "stub" };
  if (model !== "haiku" && model !== "sonnet") {
    throw new Error(`unknown --model "${model}" (expected: haiku | sonnet).`);
  }
  // Dynamic import keeps @opusfinder/llm (and @anthropic-ai/sdk) OFF the keyless path — a plain
  // `pnpm eval:extraction` never loads the SDK, exactly like eval.ts defers @opusfinder/rerank.
  const { makeJobEnrichmentExtractor } = await import("@opusfinder/llm");
  return { extract: makeJobEnrichmentExtractor({ model }), label: model };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const model = getFlag(args, "--model") ?? "haiku";
  const dataset = getFlag(args, "--dataset") ?? join(PKG_ROOT, "data", "extraction-fixtures.jsonl");

  // --model only applies to the live extractor; warn so `--model sonnet` WITHOUT --live doesn't silently run
  // the stub and read as a real Sonnet measurement (the eval.ts --embedder-on-random-ranker precedent).
  if (!live && getFlag(args, "--model") !== undefined) {
    console.warn(`Note: --model "${model}" is ignored without --live (the keyless stub run ignores the model).`);
  }

  const { extract, label } = await resolveExtractor(live, model);

  const fixtures = loadFixtures(dataset);
  if (fixtures.length === 0) {
    console.error(`No fixtures in ${relativeToPkg(dataset)}. Add hand-labeled examples first.`);
    process.exitCode = 1;
    return;
  }

  // Sequential on purpose: the live path hits the API, and a labeled set is small — no need to burst.
  const predictions: JobEnrichment[] = [];
  for (const fx of fixtures) {
    predictions.push(await extract({ title: fx.title, descriptionText: fx.description }));
  }

  const report = scoreExtraction(label, relativeToPkg(dataset), fixtures, predictions);
  console.log(formatExtractionReport(report));

  // The gate headline: the WORST per-field hallucination rate (false-positive — a column a filter would
  // trust). NaN-safe: a field absent in no fixture has no rate.
  const worst = report.fields
    .map((c) => ({ field: c.field, rate: hallucinationRate(c) }))
    .filter((x) => !Number.isNaN(x.rate))
    .sort((a, b) => b.rate - a.rate)[0];
  console.log(
    worst
      ? `\nGate (F4-FILTER precondition): worst hallucinated-when-absent rate = ${(worst.rate * 100).toFixed(1)}% (${worst.field}).`
      : "\nGate: no field is absent in any fixture — add fixtures with absent comp/years to measure hallucination.",
  );
  if (!live) {
    console.log("(stub run — NOT a quality signal; re-run with `-- --live` for real accuracy.)");
  }

  const reportPath = join(PKG_ROOT, "reports", `extraction-${label}.json`);
  writeExtractionReport(reportPath, report);
  console.log(`\nWrote ${relativeToPkg(reportPath)}`);
}

/** Byte-deterministic write (no timestamp), mirroring report.ts's writeReport. */
function writeExtractionReport(path: string, report: ExtractionReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

await runScript("EvalExtraction", main);
