import { describe, expect, it } from "vitest";

import { compareScoreRuns } from "./score-parity";

// The two-path comparison behind a transport check, on numbers small enough to work by hand.
describe("compareScoreRuns", () => {
  it("passes two paths that differ by less than they vary run to run", () => {
    // Item means: A 0.5 and 0.2, B 0.52 and 0.2. Sample variances: A 0.01 and 0, B 0.0064 and 0.
    const parity = compareScoreRuns(
      [
        [0.4, 0.2],
        [0.6, 0.2],
      ],
      [
        [0.44, 0.2],
        [0.6, 0.2],
      ],
    );

    expect(parity.items).toBe(2);
    expect(parity.dropped).toBe(0);
    expect(parity.meanAbsDifference).toBeCloseTo(0.01, 10);
    expect(parity.meanSignedDifference).toBeCloseTo(0.01, 10);
    expect(parity.runToRunSd.a).toBeCloseTo(Math.sqrt(0.01), 10);
    expect(parity.runToRunSd.b).toBeCloseTo(Math.sqrt(0.0064), 10);
    expect(parity.pass).toBe(true);
  });

  it("fails two steady paths that disagree", () => {
    const parity = compareScoreRuns(
      [
        [0.2, 0.8],
        [0.2, 0.8],
      ],
      [
        [0.5, 0.5],
        [0.5, 0.5],
      ],
    );

    // The item gaps are +0.3 and −0.3: they cancel in the signed mean, not in the absolute one.
    expect(parity.meanAbsDifference).toBeCloseTo(0.3, 10);
    expect(parity.meanSignedDifference).toBeCloseTo(0, 10);
    expect(parity.runToRunSd).toEqual({ a: 0, b: 0 });
    expect(parity.pass).toBe(false);
  });

  it("drops an item any run left unscored, and counts it", () => {
    const parity = compareScoreRuns(
      [
        [0.1, 0.9, 0.5],
        [0.1, undefined, 0.5],
      ],
      [
        [0.1, 0.9, 0.5],
        [0.1, 0.9, 0.5],
      ],
    );

    expect(parity.items).toBe(2);
    expect(parity.dropped).toBe(1);
    expect(parity.meanAbsDifference).toBe(0);
    expect(parity.pass).toBe(true);
  });

  it("needs two runs per path, the same items in every run, and something to compare", () => {
    expect(() => compareScoreRuns([[0.1]], [[0.1], [0.1]])).toThrow(
      "score parity needs two or more runs per path.",
    );
    expect(() => compareScoreRuns([[0.1], [0.1, 0.2]], [[0.1], [0.1]])).toThrow(
      "score parity needs the same items in every run.",
    );
    expect(() => compareScoreRuns([[undefined], [0.1]], [[0.1], [0.1]])).toThrow(
      "score parity: no item was scored in every run.",
    );
  });
});
