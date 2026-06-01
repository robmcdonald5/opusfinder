import { chunkByLimits } from "./contract";
import {
  CHARS_PER_TOKEN,
  embedRequest,
  EMBED_MODEL,
  MAX_ITEMS_PER_REQUEST,
  MAX_TOKENS_PER_REQUEST,
  type VoyageInputType,
} from "./provider";

export type { VoyageInputType };

export interface EmbedParams {
  /**
   * Voyage retrieval hint. Embed the corpus (jobs) as "document" and the search text
   * (the user profile) as "query"; the asymmetry improves retrieval. Defaults to null
   * (no prompt prepended).
   */
  inputType?: VoyageInputType;
}

export interface EmbedResult {
  /** One vector per input text, in input order. */
  embeddings: number[][];
  /** Voyage token usage, summed across the (possibly chunked) requests. */
  usage: { totalTokens: number };
  /** The embedding model used (for logging / provenance). */
  model: string;
}

/**
 * Embed an arbitrary number of texts, transparently chunking to respect Voyage's
 * per-request limits, preserving input order and summing token usage. Provider-agnostic:
 * all Voyage specifics live in ./provider (the swap point). Empty input short-circuits
 * with no network call.
 */
export async function embed(texts: string[], params: EmbedParams = {}): Promise<EmbedResult> {
  const inputType = params.inputType ?? null;
  if (texts.length === 0) {
    return { embeddings: [], usage: { totalTokens: 0 }, model: EMBED_MODEL };
  }

  const limits = {
    maxItems: MAX_ITEMS_PER_REQUEST,
    maxTokens: MAX_TOKENS_PER_REQUEST,
    charsPerToken: CHARS_PER_TOKEN,
  };
  const embeddings: number[][] = [];
  let totalTokens = 0;
  for (const chunk of chunkByLimits(texts, limits)) {
    const res = await embedRequest(chunk, inputType);
    embeddings.push(...res.embeddings);
    totalTokens += res.totalTokens;
  }
  return { embeddings, usage: { totalTokens }, model: EMBED_MODEL };
}
