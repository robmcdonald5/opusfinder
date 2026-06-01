import { isRecord } from "@opusfinder/shared";

/**
 * The provider-agnostic embedding-request contract: the request CHUNKING algorithm and the
 * response-envelope VALIDATION, shared by the shipped Voyage provider and the eval-only
 * OpenAI embedder. Provider-specific facts (limits, dimensions, name) are injected, so these
 * invariants have ONE definition instead of a copy per provider that drifts. Anything
 * provider-specific (endpoint, model id, request body) stays in the provider module.
 */

/** Per-request limits the chunker enforces; the provider supplies its own values. */
export interface ChunkLimits {
  /** Max input items per request. */
  maxItems: number;
  /** Max estimated tokens per request (summed over the batch). */
  maxTokens: number;
  /** Chars-per-token estimate — deliberately LOW (dense-text worst case). */
  charsPerToken: number;
}

/**
 * Split `texts` into chunks respecting BOTH the item cap and a rough token budget. A single
 * text that alone exceeds the token budget still goes out as its own chunk (the provider
 * truncates it per its default `truncation`) rather than stalling.
 */
export function* chunkByLimits(texts: string[], limits: ChunkLimits): Generator<string[]> {
  let batch: string[] = [];
  let batchTokens = 0;
  for (const text of texts) {
    const estTokens = Math.ceil(text.length / limits.charsPerToken);
    const wouldExceed =
      batch.length >= limits.maxItems || batchTokens + estTokens > limits.maxTokens;
    if (batch.length > 0 && wouldExceed) {
      yield batch;
      batch = [];
      batchTokens = 0;
    }
    batch.push(text);
    batchTokens += estTokens;
  }
  if (batch.length > 0) yield batch;
}

export interface ParseEmbeddingOptions {
  /** Provider name for error messages, e.g. "Voyage" or "OpenAI". */
  provider: string;
  /** Required vector width; a mismatch throws before the vector reaches pgvector. */
  expectedDimensions: number;
  /** Number of inputs sent; a count mismatch throws. */
  expectedCount: number;
}

export interface ParsedEmbeddings {
  /** One vector per input, in input order. */
  embeddings: number[][];
  /** usage.total_tokens from the response (0 if the provider omits it). */
  totalTokens: number;
}

/**
 * Validate an OpenAI-shaped embeddings response envelope (`{ data: [{ embedding, index }],
 * usage }`, which Voyage also uses) and extract order-aligned, dimension- and finite-checked
 * vectors plus token usage. The dimension + finite checks run before these vectors reach the
 * pgvector `::vector(N)` cast (or cosine scoring), where a bad value would otherwise fail with
 * an opaque error or silently corrupt a ranking.
 */
export function parseEmbeddingResponse(
  body: unknown,
  opts: ParseEmbeddingOptions,
): ParsedEmbeddings {
  const { provider, expectedDimensions, expectedCount } = opts;
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error(`${provider} embeddings response missing a \`data\` array.`);
  }

  const rows = body.data.map((item: unknown, i: number) => {
    if (!isRecord(item) || !Array.isArray(item.embedding)) {
      throw new Error(`${provider} embeddings response item ${i} is missing its vector.`);
    }
    const embedding = item.embedding as number[];
    if (embedding.length !== expectedDimensions) {
      throw new Error(
        `${provider} returned a ${embedding.length}-dim vector for item ${i}; expected ${expectedDimensions}.`,
      );
    }
    if (!embedding.every((x) => typeof x === "number" && Number.isFinite(x))) {
      throw new Error(`${provider} returned a non-finite embedding component for item ${i}.`);
    }
    const index = typeof item.index === "number" ? item.index : i;
    return { index, embedding };
  });

  // Providers return results in request order, but sort by `index` defensively so a future
  // out-of-order response can never misalign a vector with its input text.
  rows.sort((a, b) => a.index - b.index);
  if (rows.length !== expectedCount) {
    throw new Error(`${provider} returned ${rows.length} embeddings for ${expectedCount} inputs.`);
  }

  const usage = isRecord(body.usage) ? body.usage : undefined;
  const totalTokens =
    usage && typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : 0;

  return { embeddings: rows.map((r) => r.embedding), totalTokens };
}
