/**
 * Cosine similarity between two equal-length vectors. The embedding ranker (Phase 5) ranks a
 * candidate pool in memory with this — no DB / HNSW needed, because a labeled example's pool
 * is tiny (tens of jobs) and the comparison must score BOTH providers' vectors without ever
 * touching the single production `jobs.embedding` column. Returns a value in [-1, 1]; larger
 * = more similar. Throws on a length mismatch (a provider / dimension bug) instead of silently
 * returning a meaningless number.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch (${a.length} vs ${b.length}).`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  // A zero vector has no direction; define similarity as 0 rather than dividing by zero.
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
