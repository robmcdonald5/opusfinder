/**
 * Deterministic PRNG helpers shared by the stub rankers (random, llm-rerank). Both seed a stable
 * pseudo-random value from a string so their committed baseline reports never churn; keeping ONE
 * definition here means the determinism contract can't drift between the two rankers.
 */

/** FNV-1a 32-bit string hash — a stable seed from a string (e.g. a profile id, or the rerank system). */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — a tiny, fast, well-distributed deterministic PRNG (returns [0, 1)). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
