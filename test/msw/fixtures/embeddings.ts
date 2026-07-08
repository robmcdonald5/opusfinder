import { oneHot } from "@test/db/vectors";

export interface EmbeddingsEnvelope {
  data: { embedding: number[]; index: number }[];
  usage: { total_tokens: number };
}

/**
 * An OpenAI-shaped embeddings response envelope (Voyage and OpenAI both use it): one vector per input
 * plus usage. Vectors default to a distinct one-hot per position (so a suite can assert order/alignment)
 * and are EMBEDDING_DIMENSIONS-wide via `@test/db/vectors` — never a hardcoded 1024. Pass `vectorFor` to
 * encode input identity when a reassembly assertion needs it, or `totalTokens` to pin usage.
 */
export function embeddingsEnvelope(
  count: number,
  opts: { totalTokens?: number; vectorFor?: (index: number) => number[] } = {},
): EmbeddingsEnvelope {
  const vectorFor = opts.vectorFor ?? oneHot;
  return {
    data: Array.from({ length: count }, (_item, i) => ({ embedding: vectorFor(i), index: i })),
    usage: { total_tokens: opts.totalTokens ?? count },
  };
}
