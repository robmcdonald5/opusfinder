import { embed } from "@opusfinder/embeddings";

import type { Embedder } from "./types";

/**
 * Voyage embedder for eval — delegates to the shipped `@opusfinder/embeddings` `embed()`, so
 * the comparison's Voyage side is byte-identical to production retrieval (same model, dims,
 * chunking, query/document prompting). No retry/throttle handling here: the embed batches are
 * small and the comparison run is occasional.
 */
export const voyageEmbedder: Embedder = async (texts, inputType) => {
  const res = await embed(texts, { inputType });
  return res.embeddings;
};
