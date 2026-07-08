import { EMBEDDING_DIMENSIONS } from "@opusfinder/db/schema";

/**
 * Deterministic embedding fixtures for the PGlite integration suites, sized from the ONE schema
 * constant so a future dimension change (e.g. an embedding-model swap) updates every suite at once
 * instead of leaving hardcoded 1024s to fail as opaque vectorLiteral/pgvector dimension mismatches.
 */

/** A one-hot vector: orthogonal one-hots give EXACT cosine distances — d(v_i, v_i) === 0 and
 *  d(v_i, v_j) === 1 for i !== j — so ordering assertions are precise, never approximate. */
export function oneHot(index: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  v[index] = 1;
  return v;
}

/** A unit-norm vector confined to dims 0+1: cosine distance from oneHot(0) is exactly 1 - x.
 *  Pass Pythagorean pairs to keep the norm exactly 1 — (0.6, 0.8) → d=0.4, (0.28, 0.96) → d=0.72 —
 *  for strictly-distinct intermediate distances no tie can mask. */
export function blend(x: number, y: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  v[0] = x;
  v[1] = y;
  return v;
}
