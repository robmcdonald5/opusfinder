/**
 * Eval runner CLI (Phase 5). Runs a ranker over the labeled set, prints a metrics table + the
 * delta vs the last committed report, and rewrites that report. The committed report is the
 * BASELINE you diff future runs against — the whole point of the harness: any rerank / model /
 * embedding change replays through here and surfaces as a metric movement before it ships.
 *
 *   pnpm eval                                               # random baseline over the real dataset
 *   pnpm eval -- --ranker embedding --embedder voyage       # vector retrieval (Voyage)
 *   pnpm eval -- --ranker embedding --embedder openai       # vector retrieval (OpenAI)
 *   pnpm eval -- --dataset data/fixture.jsonl               # synthetic smoke test
 *
 * The `--` is required: the root `pnpm eval` wrapper (pnpm --filter ... run eval) only forwards
 * args after it to tsx; without it the flags are swallowed and the default random ranker runs.
 *
 * Scoring + path conventions live in src/runner.ts so this and compare.ts score identically.
 */
import { join } from "node:path";

import { runScript } from "@opusfinder/shared/script";

import { getFlag } from "../src/cli";
import { loadDataset } from "../src/dataset";
import { resolveEmbedder } from "../src/embedders";
import { aggregate, defaultReportPath, PKG_ROOT, relativeToPkg, scoreRanker } from "../src/runner";
import { randomRanker } from "../src/rankers/random";
import { diffReports, formatReport, readReport, writeReport, type EvalReport } from "../src/report";
import type { Ranker } from "../src/types";

interface Options {
  ranker: string;
  embedder?: string;
  dataset: string;
}

function parseArgs(argv: string[]): Options {
  const args = argv.slice(2);
  const opts: Options = {
    ranker: getFlag(args, "--ranker") ?? "random",
    // Default to the real labeled set; fixture.jsonl is an explicit smoke-test target.
    dataset: getFlag(args, "--dataset") ?? join(PKG_ROOT, "data", "dataset.jsonl"),
  };
  const embedder = getFlag(args, "--embedder");
  if (embedder !== undefined) opts.embedder = embedder;
  return opts;
}

/**
 * Resolve a ranker by name. `random` is built in; `embedding` builds an embedding ranker from the
 * chosen embedder — both via dynamic import, so a plain `pnpm eval` never loads the embeddings /
 * db / dotenv stack.
 */
async function resolveRanker(
  name: string,
  embedder: string | undefined,
): Promise<{ ranker: Ranker; label: string; embedderLabel: string | null }> {
  if (name === "random") {
    // --embedder only applies to the embedding ranker; warn so a `--embedder x` run that forgot
    // `--ranker embedding` doesn't silently measure (and overwrite the baseline with) the shuffle.
    if (embedder !== undefined) {
      console.warn(
        `Note: --embedder "${embedder}" is ignored by the random ranker (did you mean --ranker embedding?).`,
      );
    }
    return { ranker: randomRanker, label: "random", embedderLabel: null };
  }
  if (name === "embedding") {
    const embedderName = embedder ?? "voyage";
    const chosen = await resolveEmbedder(embedderName);
    const { embeddingRanker } = await import("../src/rankers/embedding");
    return { ranker: embeddingRanker(chosen), label: "embedding", embedderLabel: embedderName };
  }
  if (name === "llm-rerank") {
    // --embedder doesn't apply to the rerank ranker; warn so it isn't silently ignored.
    if (embedder !== undefined) {
      console.warn(`Note: --embedder "${embedder}" is ignored by the llm-rerank ranker.`);
    }
    // Dynamic import keeps @opusfinder/rerank off the plain `pnpm eval` path. Uses the deterministic
    // stub call (no API key); the real Haiku call is wired by the Phase-10 digest pipeline.
    const { llmRerankRanker } = await import("../src/rankers/llm-rerank");
    return { ranker: llmRerankRanker(), label: "llm-rerank", embedderLabel: null };
  }
  throw new Error(`unknown ranker "${name}" (expected: random | embedding | llm-rerank).`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const { ranker, label, embedderLabel } = await resolveRanker(opts.ranker, opts.embedder);

  const examples = loadDataset(opts.dataset);
  if (examples.length === 0) {
    console.error(`No examples in ${relativeToPkg(opts.dataset)}. Add labeled examples first.`);
    process.exitCode = 1;
    return;
  }

  const perExample = await scoreRanker(ranker, examples);
  const report: EvalReport = {
    ranker: label,
    embedder: embedderLabel,
    dataset: relativeToPkg(opts.dataset),
    exampleCount: examples.length,
    metrics: aggregate(perExample),
  };

  const reportPath = defaultReportPath(label, embedderLabel, opts.dataset);
  const prev = readReport(reportPath);

  console.log(formatReport(report));
  console.log("\nΔ vs last committed run:");
  console.log(diffReports(prev, report));

  writeReport(reportPath, report);
  console.log(`\nWrote ${relativeToPkg(reportPath)}`);
}

await runScript("Eval", main);
