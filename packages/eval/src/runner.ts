/**
 * Shared eval orchestration: score a ranker over the labeled set, aggregate, and the
 * report path conventions. Extracted so `scripts/eval.ts` and `scripts/compare.ts` score through
 * the IDENTICAL path — if the comparison scored differently from the single-ranker run, the
 * Voyage-vs-OpenAI numbers would be meaningless.
 */
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateAtK,
  DEFAULT_KS,
  scoreRanking,
  type AggregateMetrics,
  type MetricsAtK,
} from "./metrics";
import type { EvalExample, Ranker } from "./types";

// src/runner.ts lives one level below the package root — same depth as scripts/, so this resolves
// to packages/eval regardless of which script imports it (cwd-independent, like embeddings/env.ts).
export const PKG_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

/** Forward-slashed, package-relative path — stable across machines in the committed report. */
export function relativeToPkg(p: string): string {
  return relative(PKG_ROOT, p).split(sep).join("/");
}

/**
 * Report path keyed by ranker config AND dataset, e.g. reports/embedding-voyage.dataset.json. The
 * dataset tag stops a fixture smoke-run from clobbering the real-dataset baseline.
 */
export function defaultReportPath(
  label: string,
  embedderLabel: string | null,
  datasetPath: string,
): string {
  const name = embedderLabel ? `${label}-${embedderLabel}` : label;
  const datasetName = basename(datasetPath).replace(/\.jsonl?$/, "");
  return join(PKG_ROOT, "reports", `${name}.${datasetName}.json`);
}

/** A ranker must return a permutation of the candidate ids — guard so a buggy ranker can't inflate
 * its score by silently dropping (likely hard) candidates. */
function assertPermutation(ranked: number[], candidateIds: number[], exampleId: string): void {
  if (ranked.length !== candidateIds.length) {
    throw new Error(
      `ranker returned ${ranked.length} ids for ${candidateIds.length} candidates (example ${exampleId}).`,
    );
  }
  const a = [...ranked].sort((x, y) => x - y);
  const b = [...candidateIds].sort((x, y) => x - y);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      throw new Error(
        `ranker output is not a permutation of candidate ids (example ${exampleId}).`,
      );
    }
  }
}

/** Run a ranker over every example, scoring at each k. Returns the flat per-(example,k) metrics. */
export async function scoreRanker(ranker: Ranker, examples: EvalExample[]): Promise<MetricsAtK[]> {
  const perExample: MetricsAtK[] = [];
  for (const ex of examples) {
    const ranked = await ranker(ex.profile, ex.candidateJobs);
    assertPermutation(
      ranked,
      ex.candidateJobs.map((j) => j.id),
      ex.profile.id,
    );
    for (const k of DEFAULT_KS) perExample.push(scoreRanking(ranked, ex.expectedGoodIds, k));
  }
  return perExample;
}

/** Aggregate per-(example,k) metrics into one AggregateMetrics per default k. */
export function aggregate(perExample: MetricsAtK[]): AggregateMetrics[] {
  return DEFAULT_KS.map((k) => aggregateAtK(perExample, k));
}
