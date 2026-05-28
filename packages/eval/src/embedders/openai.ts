/**
 * OpenAI embedder for the Phase-5 Voyage-vs-OpenAI comparison. Eval-local on purpose:
 * @opusfinder/embeddings stays committed to Voyage as the single shipped provider; OpenAI is an
 * evaluation alternative, quarantined here until evidence justifies promoting it. Uses
 * text-embedding-3-small at EMBED_DIMENSIONS (OpenAI's Matryoshka `dimensions` param) so vectors
 * are the same width as Voyage and `jobs.embedding` — an apples-to-apples cosine comparison. The
 * width comes from the shared constant (not a local literal) so it can't drift from the column.
 *
 * Request shaping mirrors the Voyage path in @opusfinder/embeddings (token-budgeted chunking +
 * per-component finite validation) so the only intended difference between the two providers is
 * the model, not the harness around it. OpenAI embeddings are symmetric, so the query/document
 * inputType is ignored (unlike Voyage). text-embedding-3 caps a single input at 8192 tokens, so
 * each input is truncated to a conservative char budget under that; for the rare job longer than
 * ~8k tokens OpenAI inherently sees less text than Voyage's larger window — a provider limit, not
 * a harness choice.
 */
import { EMBED_DIMENSIONS } from "@opusfinder/embeddings";
import { isRecord } from "@opusfinder/shared";

import { getOpenAiApiKey } from "../env";
import type { Embedder } from "./types";

const OPENAI_URL = "https://api.openai.com/v1/embeddings";
const MODEL = "text-embedding-3-small";

// Conservative chars/token estimate (dense text) — keeps each input under OpenAI's 8192-token
// per-input hard limit and budgets tokens per request, mirroring the embeddings chunker.
const CHARS_PER_TOKEN = 3;
const MAX_TOKENS_PER_INPUT = 8000; // < 8192 hard cap
const MAX_CHARS_PER_INPUT = MAX_TOKENS_PER_INPUT * CHARS_PER_TOKEN;
// OpenAI allows up to 2048 inputs and ~300K tokens per request; stay well under both.
const MAX_ITEMS_PER_REQUEST = 128;
const MAX_TOKENS_PER_REQUEST = 250_000;

export const openaiEmbedder: Embedder = async (texts) => {
  const embeddings: number[][] = [];
  for (const chunk of chunkByLimits(texts.map((t) => t.slice(0, MAX_CHARS_PER_INPUT)))) {
    embeddings.push(...(await embedBatch(chunk)));
  }
  return embeddings;
};

/**
 * Split inputs into requests respecting BOTH the item cap and a token budget (a lone over-budget
 * input still goes out by itself). Mirrors @opusfinder/embeddings' chunkByLimits; kept local
 * because OpenAI's limits differ from Voyage's and that helper isn't exported.
 */
function* chunkByLimits(texts: string[]): Generator<string[]> {
  let batch: string[] = [];
  let batchTokens = 0;
  for (const text of texts) {
    const estTokens = Math.ceil(text.length / CHARS_PER_TOKEN);
    const wouldExceed =
      batch.length >= MAX_ITEMS_PER_REQUEST || batchTokens + estTokens > MAX_TOKENS_PER_REQUEST;
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

  return parseResponse((await res.json()) as unknown, input.length);
}

/** Validate the envelope and extract order-aligned, finite-checked vectors (like the Voyage path). */
function parseResponse(body: unknown, expected: number): number[][] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error("OpenAI embeddings response missing a `data` array.");
  }
  const rows = body.data.map((item: unknown, i: number) => {
    if (!isRecord(item) || !Array.isArray(item.embedding)) {
      throw new Error(`OpenAI embeddings response item ${i} is missing its vector.`);
    }
    const embedding = item.embedding as number[];
    if (embedding.length !== EMBED_DIMENSIONS) {
      throw new Error(
        `OpenAI returned a ${embedding.length}-dim vector for item ${i}; expected ${EMBED_DIMENSIONS}.`,
      );
    }
    // A NaN/Infinity component would make cosineSimilarity return NaN and the score sort
    // arbitrary — corrupting the ranking silently. Reject it, attributed to the item (the
    // Voyage parser enforces the same invariant).
    if (!embedding.every((x) => typeof x === "number" && Number.isFinite(x))) {
      throw new Error(`OpenAI returned a non-finite embedding component for item ${i}.`);
    }
    const index = typeof item.index === "number" ? item.index : i;
    return { index, embedding };
  });
  // Sort by `index` defensively so an out-of-order response can't misalign a vector with its input.
  rows.sort((a, b) => a.index - b.index);
  if (rows.length !== expected) {
    throw new Error(`OpenAI returned ${rows.length} embeddings for ${expected} inputs.`);
  }
  return rows.map((r) => r.embedding);
}
