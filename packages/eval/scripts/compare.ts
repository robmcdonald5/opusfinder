/**
 * Voyage-vs-OpenAI embedding comparison. Runs the embedding ranker over the labeled set with EACH
 * provider through the same scoring path (src/runner), prints retrieval@k side-by-side plus the
 * delta, and writes each provider's committed report.
 *
 *   pnpm eval:compare
 *   pnpm eval:compare -- --dataset data/fixture.jsonl
 */
import { join } from "node:path";

import { runScript } from "@opusfinder/shared/script";

import { getFlag } from "../src/cli";
import { loadDataset } from "../src/dataset";
import { resolveEmbedder } from "../src/embedders";
import { embeddingRanker } from "../src/rankers/embedding";
import {
  diffReports,
  formatReport,
  ppDelta,
  readReport,
  writeReport,
  type EvalReport,
} from "../src/report";
import { aggregate, defaultReportPath, PKG_ROOT, relativeToPkg, scoreRanker } from "../src/runner";

const PROVIDERS = ["voyage", "openai"] as const;

function datasetArg(): string {
  return getFlag(process.argv.slice(2), "--dataset") ?? join(PKG_ROOT, "data", "dataset.jsonl");
}

async function main(): Promise<void> {
  const datasetPath = datasetArg();
  const examples = loadDataset(datasetPath);
  if (examples.length === 0) {
    console.error(`No examples in ${relativeToPkg(datasetPath)}.`);
    process.exitCode = 1;
    return;
  }

  // Providers fail independently (e.g. one account out of quota), so a failure in one must not
  // discard the other's results — catch per provider and report what succeeded.
  const reports: EvalReport[] = [];
  const prevByProvider = new Map<string, EvalReport | null>();
  const failures: { provider: string; message: string }[] = [];
  for (const provider of PROVIDERS) {
    try {
      const embedder = await resolveEmbedder(provider);
      const perExample = await scoreRanker(embeddingRanker(embedder), examples);
      const report: EvalReport = {
        ranker: "embedding",
        embedder: provider,
        dataset: relativeToPkg(datasetPath),
        exampleCount: examples.length,
        metrics: aggregate(perExample),
      };
      const reportPath = defaultReportPath("embedding", provider, datasetPath);
      // Capture the prior committed numbers BEFORE overwriting, so each provider gets its own "vs last committed run" delta.
      prevByProvider.set(provider, readReport(reportPath));
      reports.push(report);
      writeReport(reportPath, report);
    } catch (err) {
      failures.push({ provider, message: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log(
    `Voyage vs OpenAI — embedding retrieval over ${examples.length} examples ` +
      `(${relativeToPkg(datasetPath)})\n`,
  );
  for (const r of reports) {
    console.log(formatReport(r));
    console.log("  Δ vs last committed run:");
    console.log(diffReports(prevByProvider.get(r.embedder ?? "") ?? null, r));
    console.log("");
  }
  if (reports.length === PROVIDERS.length) printDelta(reports);

  if (failures.length > 0) {
    console.error("Incomplete comparison — provider(s) failed:");
    for (const f of failures) console.error(`  ${f.provider}: ${f.message}`);
    // Non-zero exit: the head-to-head didn't fully run, even though any succeeded side was saved.
    process.exitCode = 1;
  }
}

/** Δ (OpenAI − Voyage) in percentage points per k — positive favors OpenAI. */
function printDelta(reports: EvalReport[]): void {
  const [voyage, openai] = reports;
  if (!voyage || !openai) return;
  const byK = new Map(voyage.metrics.map((m) => [m.k, m]));
  console.log("Δ (OpenAI − Voyage), percentage points (positive favors OpenAI):");
  for (const m of openai.metrics) {
    const v = byK.get(m.k);
    if (!v) continue;
    console.log(
      `  @${String(m.k).padEnd(2)}  P ${ppDelta(v.precision, m.precision)}  ` +
        `R ${ppDelta(v.recall, m.recall)}  NDCG ${ppDelta(v.ndcg, m.ndcg)}`,
    );
  }
}

await runScript("Compare", main);
