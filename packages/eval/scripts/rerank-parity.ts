/**
 * Does the eval's model caller score like production's? Reranks the 2 legacy examples (80 candidates each)
 * several times through each path with the same model, Haiku 5.5, and compares the paths:
 *
 *   production — `generateObject` from @opusfinder/llm, the call the digest makes (Messages API)
 *   eval       — `modelRerankCall` on the eval's caller (chat completions, pinned to Anthropic)
 *
 * SCORE: one candidate's 0.0–1.0 relevance score from one run, as `rerankCandidates` returns it: 160 per
 * run. A candidate some run left unscored is dropped from the comparison and counted.
 * PASS: the mean over candidates of |eval's mean score − production's mean score| is at most the larger of
 * the two paths' run-to-run SD (see src/score-parity.ts). Exits 1 otherwise.
 *
 *   pnpm --filter @opusfinder/eval rerank:parity            # 3 runs per path, about $0.15
 *   pnpm --filter @opusfinder/eval rerank:parity -- --runs 5
 */
import { join } from "node:path";

import {
  generateObject,
  modelId,
  ObjectGenerationError,
  RerankScoresSchema,
  renderRerankCandidates,
} from "@opusfinder/llm/node";
import { rerankCandidates, type RerankCall } from "@opusfinder/rerank";
import { runScript } from "@opusfinder/shared/script";

import { getFlag } from "../src/cli";
import { loadDataset } from "../src/dataset";
import type { ModelRoute } from "../src/model-caller";
import { modelRerankCall } from "../src/rankers/model-rerank";
import { PKG_ROOT } from "../src/runner";
import { compareScoreRuns } from "../src/score-parity";
import type { EvalExample } from "../src/types";

const ROUTE: ModelRoute = { model: modelId("haiku"), hosts: ["anthropic"] };

interface RunTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  served: Set<string>;
}

const newTotals = (): RunTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  served: new Set(),
});

/** The digest's rerank call (packages/inngest/src/deps.ts), with its spend counted into `totals`. The
 *  Messages API reports input tokens without the cached part, so the cache counters are added back. */
function productionCall(totals: RunTotals): RerankCall {
  const count = (spent: {
    usage: { inputTokens: number; outputTokens: number; costUsd: number };
    cache: { creationInputTokens: number; readInputTokens: number };
  }) => {
    totals.inputTokens +=
      spent.usage.inputTokens + spent.cache.creationInputTokens + spent.cache.readInputTokens;
    totals.outputTokens += spent.usage.outputTokens;
    totals.costUsd += spent.usage.costUsd;
  };
  return async (system, chunk) => {
    try {
      const result = await generateObject({
        model: "haiku",
        system,
        cacheSystem: true,
        schema: RerankScoresSchema,
        messages: [{ role: "user", content: renderRerankCandidates(chunk) }],
        effort: "low",
        maxOutputTokens: 4096,
      });
      count(result);
      return result.object.scores;
    } catch (err) {
      if (!(err instanceof ObjectGenerationError)) throw err;
      count(err.spent);
      console.warn(`production: chunk left unscored: ${err.message}`);
      return [];
    }
  };
}

function evalCall(totals: RunTotals): RerankCall {
  return modelRerankCall(ROUTE, {
    onReply: ({ usage, served }) => {
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.costUsd += usage.costUsd;
      totals.served.add(`${served.host ?? "?"} · ${served.model ?? "?"}`);
    },
  });
}

/** One run: every example reranked once. The scores come back in example order, then candidate order. */
async function scoreRun(
  examples: EvalExample[],
  call: RerankCall,
): Promise<(number | undefined)[]> {
  const perExample = await Promise.all(
    examples.map(async (ex) => {
      const { scores } = await rerankCandidates(ex.profile, ex.candidateJobs, call);
      return ex.candidateJobs.map((job) => scores.get(job.id));
    }),
  );
  return perExample.flat();
}

async function main(): Promise<void> {
  const runs = Number(getFlag(process.argv.slice(2), "--runs") ?? 3);
  if (!Number.isInteger(runs) || runs < 2) throw new Error("--runs must be an integer >= 2.");
  const examples = loadDataset(join(PKG_ROOT, "data", "legacy-examples.jsonl"));

  const production: (number | undefined)[][] = [];
  const evalSide: (number | undefined)[][] = [];
  console.log("path        run  scored  mean score  input tok  output tok  cost $    served by");
  // The paths alternate, so anything that drifts over the minutes this takes lands on both.
  for (let run = 1; run <= runs; run++) {
    for (const path of ["production", "eval"] as const) {
      const totals = newTotals();
      const scores = await scoreRun(
        examples,
        path === "production" ? productionCall(totals) : evalCall(totals),
      );
      (path === "production" ? production : evalSide).push(scores);
      const scored = scores.filter((s) => s !== undefined);
      console.log(
        [
          path.padEnd(11),
          String(run).padEnd(4),
          `${scored.length}/${scores.length}`.padEnd(7),
          (scored.reduce((sum, s) => sum + s, 0) / scored.length).toFixed(4).padEnd(11),
          String(totals.inputTokens).padEnd(10),
          String(totals.outputTokens).padEnd(11),
          totals.costUsd.toFixed(4).padEnd(9),
          [...totals.served].join("; ") || "(not reported by this path)",
        ].join(" "),
      );
    }
  }

  const parity = compareScoreRuns(production, evalSide);
  console.log(`\ncandidates compared: ${parity.items} (dropped: ${parity.dropped})`);
  console.log(`mean |eval − production| per candidate: ${parity.meanAbsDifference.toFixed(4)}`);
  console.log(`mean (eval − production):               ${parity.meanSignedDifference.toFixed(4)}`);
  console.log(`run-to-run SD, production:              ${parity.runToRunSd.a.toFixed(4)}`);
  console.log(`run-to-run SD, eval:                    ${parity.runToRunSd.b.toFixed(4)}`);
  console.log(
    parity.pass ? "PASS" : "FAIL: the paths differ by more than either varies run to run.",
  );
  if (!parity.pass) process.exitCode = 1;
}

await runScript("Rerank parity", main);
