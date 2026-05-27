import { isRecord } from "@opusfinder/shared";

import { getVoyageApiKey } from "./env";

/**
 * Voyage retrieval hint. Embed the corpus (jobs) as "document" and the search text
 * (the user profile, Phase 9) as "query"; Voyage prepends a model-specific prompt per
 * type and the asymmetry measurably improves retrieval. `null` prepends nothing.
 */
export type VoyageInputType = "query" | "document" | null;

// --- Provider swap point ------------------------------------------------------------
// All Voyage-specific wiring lives in this file: the endpoint, model id, output
// dimensions, list price, and the request/response mapping in `embedRequest`. Swapping
// to OpenAI (the Phase-5 eval comparison) means changing these constants + the body and
// parsing below PLUS the key guard in env.ts (getVoyageApiKey -> an OpenAI key) — but
// nothing in embed.ts, which stays provider-agnostic and only calls embedRequest(). e.g.
//
//   const URL = "https://api.openai.com/v1/embeddings";
//   const EMBED_MODEL = "text-embedding-3-small";
//   // body: { model, input, dimensions: 1024 }  // MUST request 1024 dims to reuse the
//   //                                            // jobs.embedding vector(1024) column
//
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
export const EMBED_MODEL = "voyage-3-large";
// Must match the jobs.embedding column width (EMBEDDING_DIMENSIONS in @opusfinder/db).
// 1024 is also voyage-3-large's default output dimension.
export const EMBED_DIMENSIONS = 1024;

// Per-request limits the embed() chunker enforces. They live HERE (the swap point) with
// the other provider facts, so a provider swap updates them in one place. Voyage caps a
// request at 1000 inputs and ~120K tokens for voyage-3-large. CHARS_PER_TOKEN is a
// deliberately LOW (worst-case dense text) estimate, so MAX_TOKENS_PER_REQUEST is an UPPER
// bound on real tokens — at ~3 chars/token a 90K-token estimate stays under the 120K cap
// even for code/punctuation-heavy postings.
export const MAX_ITEMS_PER_REQUEST = 128;
export const MAX_TOKENS_PER_REQUEST = 90_000;
export const CHARS_PER_TOKEN = 3;

// voyage-3-large list price, USD per 1M tokens (pinned 2026-05; revisit if Voyage
// changes pricing or the model is swapped). The first 200M tokens are free.
const PRICE_PER_MTOK_USD = 0.18;

/** Estimate the USD cost of embedding `totalTokens` at the current model's list price. */
export function estimateCostUsd(totalTokens: number): number {
  return (totalTokens / 1_000_000) * PRICE_PER_MTOK_USD;
}

/**
 * Human-readable token + cost suffix for embedding logs, e.g. "76486 tokens, ~$0.0138".
 * Shared by the backfill + ingestion scripts so the wording/precision can't drift.
 */
export function formatEmbedCost(totalTokens: number): string {
  return `${totalTokens} tokens, ~$${estimateCostUsd(totalTokens).toFixed(4)}`;
}

export interface VoyageEmbedResponse {
  /** One vector per input, aligned to input order. */
  embeddings: number[][];
  /** usage.total_tokens from the response (0 if the provider omits it). */
  totalTokens: number;
}

/**
 * One Voyage embeddings request. `input` MUST already respect the API limits (<=1000
 * items and the per-request token budget) — chunking is embed()'s job, not this layer's.
 * Returns vectors aligned to input order plus usage for cost accounting.
 */
export async function embedRequest(
  input: string[],
  inputType: VoyageInputType,
): Promise<VoyageEmbedResponse> {
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getVoyageApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input,
      input_type: inputType,
      output_dimension: EMBED_DIMENSIONS,
    }),
  });

  if (!res.ok) {
    // Read the body for a diagnostic snippet (Voyage error payloads never echo the
    // key); reading it also drains the stream so no socket handle lingers, which keeps
    // the Windows process exiting cleanly (same caveat as the Greenhouse adapter).
    const snippet = await res.text().catch(() => "");
    throw new Error(
      `Voyage embeddings request failed: ${res.status} ${res.statusText}` +
        (snippet ? ` - ${snippet.slice(0, 300)}` : ""),
    );
  }

  return parseResponse((await res.json()) as unknown, input.length);
}

/** Validate the response envelope and extract order-aligned vectors + token usage. */
function parseResponse(body: unknown, expected: number): VoyageEmbedResponse {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new Error("Voyage embeddings response missing a `data` array.");
  }

  const rows = body.data.map((item: unknown, i: number) => {
    if (!isRecord(item) || !Array.isArray(item.embedding)) {
      throw new Error(`Voyage embeddings response item ${i} is missing its vector.`);
    }
    const embedding = item.embedding as number[];
    // Validate before these reach the pgvector `::vector(N)` cast downstream: a wrong-length
    // or non-finite vector would otherwise fail the whole write batch with an opaque cast
    // error. Catch it here, attributed to the specific response item.
    if (embedding.length !== EMBED_DIMENSIONS) {
      throw new Error(
        `Voyage returned a ${embedding.length}-dim vector for item ${i}; expected ${EMBED_DIMENSIONS}.`,
      );
    }
    if (!embedding.every((x) => typeof x === "number" && Number.isFinite(x))) {
      throw new Error(`Voyage returned a non-finite embedding component for item ${i}.`);
    }
    const index = typeof item.index === "number" ? item.index : i;
    return { index, embedding };
  });

  // Voyage returns results in request order, but sort by `index` defensively so a
  // future out-of-order response can never misalign a vector with its input text.
  rows.sort((a, b) => a.index - b.index);
  if (rows.length !== expected) {
    throw new Error(`Voyage returned ${rows.length} embeddings for ${expected} inputs.`);
  }

  const usage = isRecord(body.usage) ? body.usage : undefined;
  const totalTokens =
    usage && typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : 0;

  return { embeddings: rows.map((r) => r.embedding), totalTokens };
}
