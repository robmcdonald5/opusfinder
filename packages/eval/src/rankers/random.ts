/**
 * The stub ranker (Phase 5 gate): a DETERMINISTIC shuffle of the candidate ids. It is the
 * floor every real ranker must clear, and it proves the harness end-to-end with zero network
 * or DB dependency. Determinism matters — a `Math.random` shuffle would make the committed
 * baseline report churn every run, turning the diff-vs-last-run into pure noise. The shuffle
 * is therefore seeded from `profile.id`, so the same dataset always yields the same baseline.
 */
import type { Ranker } from "../types";

/** mulberry32 — a tiny, fast, well-distributed deterministic PRNG (returns [0, 1)). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit string hash — derives a stable per-example seed from the profile id. */
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

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
