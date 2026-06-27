/**
 * The stub ranker: a DETERMINISTIC shuffle of the candidate ids. It is the
 * floor every real ranker must clear, and it proves the harness end-to-end with zero network
 * or DB dependency. Determinism matters — a `Math.random` shuffle would make the committed
 * baseline report churn every run, turning the diff-vs-last-run into pure noise. The shuffle
 * is therefore seeded from `profile.id`, so the same dataset always yields the same baseline.
 */
import { hashString, mulberry32 } from "../rng";
import type { Ranker } from "../types";

export const randomRanker: Ranker = (profile, candidates) => {
  const rng = mulberry32(hashString(profile.id));
  const ids = candidates.map((j) => j.id);
  // Fisher-Yates with the seeded rng.
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = ids[i] as number;
    ids[i] = ids[j] as number;
    ids[j] = tmp;
  }
  return Promise.resolve(ids);
};
