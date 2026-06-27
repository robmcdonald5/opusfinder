/**
 * OpenAI embedder for the Voyage-vs-OpenAI comparison. Eval-local on purpose:
 * @opusfinder/embeddings stays committed to Voyage as the single shipped provider; OpenAI is an
 * evaluation alternative, quarantined here until evidence justifies promoting it. Uses
 * text-embedding-3-small at EMBED_DIMENSIONS (OpenAI's Matryoshka `dimensions` param) so vectors
 * are the same width as Voyage and `jobs.embedding` — an apples-to-apples cosine comparison. The
 * width comes from the shared constant (not a local literal) so it can't drift from the column.
 *
 * Request shaping reuses the shared embedding contract from @opusfinder/embeddings (token-budgeted
 * chunking + envelope/finite validation) so the only intended difference between the two providers
 * is the model + per-request limits, not the harness around it. OpenAI embeddings are symmetric, so the query/document
 * inputType is ignored (unlike Voyage). text-embedding-3 caps a single input at 8192 tokens, so
 * each input is truncated to a conservative char budget under that; for the rare job longer than
 * ~8k tokens OpenAI inherently sees less text than Voyage's larger window — a provider limit, not
 * a harness choice.
 */
import { chunkByLimits, EMBED_DIMENSIONS, parseEmbeddingResponse } from "@opusfinder/embeddings";

import { getOpenAiApiKey } from "../env";
import type { Embedder } from "./types";

const OPENAI_URL = "https://api.openai.com/v1/embeddings";
const MODEL = "text-embedding-3-small";

// Conservative chars/token estimate (dense text) — keeps each input under OpenAI's 8192-token
// per-input hard limit and budgets tokens per request, mirroring the embeddings chunker.
const CHARS_PER_TOKEN = 3;
const MAX_TOKENS_PER_INPUT = 8000;
const MAX_CHARS_PER_INPUT = MAX_TOKENS_PER_INPUT * CHARS_PER_TOKEN;
// OpenAI allows up to 2048 inputs and ~300K tokens per request; stay well under both.
const MAX_ITEMS_PER_REQUEST = 128;
const MAX_TOKENS_PER_REQUEST = 250_000;

export const openaiEmbedder: Embedder = async (texts) => {
  const limits = {
    maxItems: MAX_ITEMS_PER_REQUEST,
    maxTokens: MAX_TOKENS_PER_REQUEST,
    charsPerToken: CHARS_PER_TOKEN,
  };
  const embeddings: number[][] = [];
  for (const chunk of chunkByLimits(
    texts.map((t) => t.slice(0, MAX_CHARS_PER_INPUT)),
    limits,
  )) {
    embeddings.push(...(await embedBatch(chunk)));
  }
  return embeddings;
};

async function embedBatch(input: string[]): Promise<number[][]> {
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getOpenAiApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, input, dimensions: EMBED_DIMENSIONS }),
  });

  if (!res.ok) {
    // Read the body for a diagnostic snippet (OpenAI error payloads never echo the key); reading it
    // also drains the stream so no socket handle lingers (Windows clean-exit caveat).
    const snippet = await res.text().catch(() => "");
    throw new Error(
      `OpenAI embeddings request failed: ${res.status} ${res.statusText}` +
        (snippet ? ` - ${snippet.slice(0, 300)}` : ""),
    );
  }

  // Envelope validation + order-aligned extraction is the shared embedding contract; OpenAI
  // discards the token usage (the harness scores ranking quality, not cost).
  return parseEmbeddingResponse((await res.json()) as unknown, {
    provider: "OpenAI",
    expectedDimensions: EMBED_DIMENSIONS,
    expectedCount: input.length,
  }).embeddings;
}
