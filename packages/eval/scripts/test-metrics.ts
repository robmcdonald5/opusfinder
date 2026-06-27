/**
 * Self-test for the metrics math, pinned against hand-computed cases. A tsx assertion script
 * rather than a test framework — one file doesn't justify vitest; node:assert/strict's non-zero
 * exit on failure is all CI needs. Run: `pnpm --filter @opusfinder/eval test:metrics`.
 */
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cosineSimilarity } from "../src/cosine";
import { parseDatasetLines } from "../src/dataset";
import { aggregateAtK, scoreRanking } from "../src/metrics";
import { diffReports, ppDelta, readReport, writeReport, type EvalReport } from "../src/report";

const EPS = 1e-9;
const approx = (actual: number, expected: number, label: string): void => {
  assert.ok(Math.abs(actual - expected) < EPS, `${label}: expected ≈${expected}, got ${actual}`);
};

// log2(3) = 1.584962500721156; perfect/ideal DCG@3 over 3 relevant = 1 + 1/log2(3) + 1/2.
const IDCG3 = 1 + 1 / (Math.log(3) / Math.LN2) + 0.5; // ≈ 2.1309297535714573

// --- scoreRanking: perfect ranking -------------------------------------------------------
{
  const m = scoreRanking([1, 2, 3, 4, 5], [1, 2, 3], 3);
  approx(m.precision, 1, "perfect precision@3");
  approx(m.recall, 1, "perfect recall@3");
  approx(m.ndcg, 1, "perfect ndcg@3");
}

// --- scoreRanking: relevant items pushed below the cutoff --------------------------------
{
  const m = scoreRanking([4, 5, 1, 2, 3], [1, 2, 3], 3);
  approx(m.precision, 1 / 3, "worst precision@3");
  approx(m.recall, 1 / 3, "worst recall@3");
  approx(m.ndcg, 0.5 / IDCG3, "worst ndcg@3"); // one hit at rank 3 → gain 1/log2(4) = 0.5
}

// --- scoreRanking: no relevant ids → precision 0, recall/ndcg undefined (NaN) ------------
{
  const m = scoreRanking([1, 2, 3], [], 3);
  approx(m.precision, 0, "empty-good precision@3");
  assert.ok(Number.isNaN(m.recall), "empty-good recall@3 should be NaN");
  assert.ok(Number.isNaN(m.ndcg), "empty-good ndcg@3 should be NaN");
}

// --- scoreRanking: fewer candidates than k → precision divides by pool size, not k -------
{
  const m = scoreRanking([1], [1], 3);
  approx(m.precision, 1, "small-pool precision@3"); // 1 hit / min(3,1) = 1, not 1/3
  approx(m.recall, 1, "small-pool recall@3");
  approx(m.ndcg, 1, "small-pool ndcg@3");
}

// --- scoreRanking: more relevant items than k → recall divides by |good|, IDCG caps at k ----
{
  const m = scoreRanking([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], 3);
  approx(m.precision, 1, "many-relevant precision@3"); // top-3 all relevant
  approx(m.recall, 3 / 5, "many-relevant recall@3"); //   only 3 of 5 relevant fit in k=3
  // IDCG is built over min(k, |good|) = 3 ideal positions, so a perfect top-3 scores 1. Drop the
  // min() cap and IDCG would span 5 positions, pushing NDCG below 1 — this pins that cap.
  approx(m.ndcg, 1, "many-relevant ndcg@3");
}

// --- scoreRanking: empty ranking → precision guarded to 0 (no 0/0 NaN), recall/ndcg 0 -------
{
  const m = scoreRanking([], [1, 2, 3], 3);
  approx(m.precision, 0, "empty-ranking precision@3"); // denom min(3,0)=0 → guarded to 0, not NaN
  approx(m.recall, 0, "empty-ranking recall@3"); //       0 hits / 3 relevant
  approx(m.ndcg, 0, "empty-ranking ndcg@3"); //           dcg 0 / nonzero idcg
}

// --- aggregateAtK: NaN metrics are dropped from the mean, not counted as 0 ----------------
{
  const ex1 = scoreRanking([1, 2, 3], [1], 3); // precision 1/3, recall 1, ndcg 1
  const ex2 = scoreRanking([1, 2, 3], [], 3); //  precision 0,   recall NaN, ndcg NaN
  const agg = aggregateAtK([ex1, ex2], 3);
  approx(agg.precision, (1 / 3 + 0) / 2, "agg precision@3"); // both examples count
  approx(agg.recall, 1, "agg recall@3"); // only ex1 has defined recall
  approx(agg.ndcg, 1, "agg ndcg@3");
  assert.equal(agg.counts.precision, 2, "agg precision count");
  assert.equal(agg.counts.recall, 1, "agg recall count (NaN dropped)");
  assert.equal(agg.counts.ndcg, 1, "agg ndcg count (NaN dropped)");
}

{
  approx(cosineSimilarity([1, 0], [1, 0]), 1, "cosine identical");
  approx(cosineSimilarity([1, 0], [0, 1]), 0, "cosine orthogonal");
  approx(cosineSimilarity([1, 1], [1, 1]), 1, "cosine parallel");
  approx(cosineSimilarity([1, 0], [-1, 0]), -1, "cosine opposite");
  approx(cosineSimilarity([0, 0], [1, 1]), 0, "cosine zero-vector");
  assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), "cosine length mismatch should throw");
}

// --- dataset loader: parses valid lines, skips comments/blanks, validates at the boundary --
{
  const valid =
    '{"profile":{"id":"p1","summary":"s","skills":["Go"],"targetRoles":["Backend"]},' +
    '"candidateJobs":[{"id":1,"title":"t","descriptionText":"d"}],"expectedGoodIds":[1]}';
  const parsed = parseDatasetLines(`# header\n\n${valid}`);
  assert.equal(parsed.length, 1, "loader skips comment/blank lines and parses one example");
  assert.equal(parsed[0]?.profile.id, "p1", "loader preserves profile id");

  assert.throws(() => parseDatasetLines('{"profile":'), "loader rejects malformed JSON");
  // expectedGoodIds pointing outside the candidate pool is a labeling bug — must throw.
  const outOfPool =
    '{"profile":{"id":"p1","summary":"s","skills":[],"targetRoles":[]},' +
    '"candidateJobs":[{"id":1,"title":"t","descriptionText":"d"}],"expectedGoodIds":[2]}';
  assert.throws(() => parseDatasetLines(outOfPool), "loader rejects out-of-pool good id");
  const missing =
    '{"profile":{"id":"p1","skills":[],"targetRoles":[]},"candidateJobs":[],"expectedGoodIds":[]}';
  assert.throws(() => parseDatasetLines(missing), "loader rejects a profile missing summary");

  // A candidate blank on BOTH title and description embeds to "" and 400s the embedder — reject.
  const blankJob =
    '{"profile":{"id":"p1","summary":"s","skills":[],"targetRoles":[]},' +
    '"candidateJobs":[{"id":1,"title":"  ","descriptionText":""}],"expectedGoodIds":[]}';
  assert.throws(() => parseDatasetLines(blankJob), "loader rejects a contentless job");

  // A profile empty on summary AND skills AND targetRoles embeds to "" — reject.
  const blankProfile =
    '{"profile":{"id":"p1","summary":"  ","skills":[],"targetRoles":[]},' +
    '"candidateJobs":[{"id":1,"title":"t","descriptionText":"d"}],"expectedGoodIds":[]}';
  assert.throws(() => parseDatasetLines(blankProfile), "loader rejects a contentless profile");

  // Duplicate candidate ids would double-count a hit (recall > 1) yet pass assertPermutation.
  const dupIds =
    '{"profile":{"id":"p1","summary":"s","skills":[],"targetRoles":[]},' +
    '"candidateJobs":[{"id":1,"title":"t","descriptionText":"d"},' +
    '{"id":1,"title":"u","descriptionText":"e"}],"expectedGoodIds":[1]}';
  assert.throws(() => parseDatasetLines(dupIds), "loader rejects duplicate candidate ids");
}

// --- report: NaN metrics survive the JSON round-trip as NaN (not null→0), a full 0→1 swing fits
// --- the delta column, and a malformed baseline reads as null instead of crashing the diff -------
{
  // ppDelta: one side undefined → n/a; both undefined → caller's token; a full 0→1 swing fits width.
  assert.equal(ppDelta(NaN, 0.5).trim(), "n/a", "ppDelta one side undefined → n/a");
  assert.equal(ppDelta(NaN, NaN, "=").trim(), "=", "ppDelta both undefined → token");
  assert.equal(ppDelta(0, 1).trim(), "+100.0pp", "ppDelta renders a full 0→1 swing in-width");

  const tmp = join(tmpdir(), `opusfinder-eval-report-${process.pid}.json`);
  try {
    const report: EvalReport = {
      ranker: "random",
      embedder: null,
      dataset: "d",
      exampleCount: 1,
      metrics: [
        { k: 3, precision: 0.5, recall: NaN, ndcg: NaN, counts: { precision: 1, recall: 0, ndcg: 0 } },
      ],
    };
    writeReport(tmp, report);
    const back = readReport(tmp);
    assert.ok(back !== null, "readReport returns the written report");
    assert.ok(
      Number.isNaN(back.metrics[0]!.recall),
      "a NaN metric round-trips as NaN, not null coerced to 0",
    );
    // Same metrics both runs: defined → 0.0pp, undefined → '=' (never a fabricated delta).
    assert.ok(diffReports(back, report).includes("="), "an undefined metric diffs to '=', not a number");

    writeFileSync(tmp, "{}", "utf8");
    assert.equal(readReport(tmp), null, "a report missing its metrics array reads as null");
    assert.equal(
      readReport(join(tmpdir(), `opusfinder-eval-missing-${process.pid}.json`)),
      null,
      "a missing report file reads as null",
    );
  } finally {
    rmSync(tmp, { force: true });
  }
}

console.log("eval self-test passed (metrics + cosine + dataset loader + report)");
