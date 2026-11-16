/**
 * Do two call paths to the SAME model score alike? The check behind a new transport: run the same scoring
 * job several times through each path and compare the gap between the paths with how much one path moves
 * between its own runs. The current models take no temperature, so a path never repeats itself exactly;
 * a gap inside that run-to-run spread is noise, a gap beyond it is a difference in what was sent.
 *
 * The score is one item's number in one run (for the rerank: one candidate's 0.0–1.0 relevance score).
 * Each path is `runs × items`, the items in the same order in every run of both paths.
 */

export interface ScoreParity {
  /** Items compared: those scored in every run of both paths. */
  items: number;
  /** Items left out because some run didn't score them. */
  dropped: number;
  /** Mean over items of |path A's mean score − path B's mean score|. */
  meanAbsDifference: number;
  /** Mean over items of (path B's mean score − path A's): the systematic shift, if any. */
  meanSignedDifference: number;
  /** Each path's run-to-run SD: the root of the mean, over items, of the item's sample variance across runs. */
  runToRunSd: { a: number; b: number };
  /** `meanAbsDifference` is at most the larger run-to-run SD. */
  pass: boolean;
}

/** Compare two paths' runs. `undefined` marks an item a run left unscored. Each path needs two runs or more. */
export function compareScoreRuns(
  a: readonly (readonly (number | undefined)[])[],
  b: readonly (readonly (number | undefined)[])[],
): ScoreParity {
  const width = a[0]?.length ?? 0;
  if (a.length < 2 || b.length < 2)
    throw new Error("score parity needs two or more runs per path.");
  if ([...a, ...b].some((run) => run.length !== width)) {
    throw new Error("score parity needs the same items in every run.");
  }
  let items = 0;
  let absSum = 0;
  let signedSum = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < width; i++) {
    const inA = a.map((run) => run[i]);
    const inB = b.map((run) => run[i]);
    if (![...inA, ...inB].every((s) => s !== undefined)) continue;
    const statsA = meanAndVariance(inA as number[]);
    const statsB = meanAndVariance(inB as number[]);
    items += 1;
    absSum += Math.abs(statsB.mean - statsA.mean);
    signedSum += statsB.mean - statsA.mean;
    varA += statsA.variance;
    varB += statsB.variance;
  }
  if (items === 0) throw new Error("score parity: no item was scored in every run.");
  const meanAbsDifference = absSum / items;
  const runToRunSd = { a: Math.sqrt(varA / items), b: Math.sqrt(varB / items) };
  return {
    items,
    dropped: width - items,
    meanAbsDifference,
    meanSignedDifference: signedSum / items,
    runToRunSd,
    pass: meanAbsDifference <= Math.max(runToRunSd.a, runToRunSd.b),
  };
}

/** The mean and the sample (n − 1) variance. */
function meanAndVariance(values: number[]): { mean: number; variance: number } {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const squares = values.reduce((sum, v) => sum + (v - mean) ** 2, 0);
  return { mean, variance: squares / (values.length - 1) };
}
