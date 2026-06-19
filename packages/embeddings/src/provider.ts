import { parseEmbeddingResponse } from "./contract";
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
export const EMBED_MODEL = "voyage-4-large";
// Must match the jobs.embedding column width (EMBEDDING_DIMENSIONS in @opusfinder/db).
// 1024 is also voyage-4-large's default output dimension, so the swap from voyage-3-large
// needs NO schema migration — but it DOES require a full corpus + profile re-embed: the two
// models live in different embedding spaces, so a voyage-3 vector and a voyage-4 vector
// cannot be cosine-compared (mixing them silently corrupts retrieval).
export const EMBED_DIMENSIONS = 1024;

// Per-request limits the embed() chunker enforces. They live HERE (the swap point) with
// the other provider facts, so a provider swap updates them in one place. voyage-4-large
// accepts a 32K-token context per input; these bounds (128 items, ~90K estimated tokens per
// request) stay deliberately conservative and well under Voyage's per-request caps.
// CHARS_PER_TOKEN is a deliberately LOW (worst-case dense text) estimate, so
// MAX_TOKENS_PER_REQUEST is an UPPER bound on the real token count per request.
export const MAX_ITEMS_PER_REQUEST = 128;
export const MAX_TOKENS_PER_REQUEST = 90_000;
export const CHARS_PER_TOKEN = 3;

// voyage-4-large list price, USD per 1M tokens (pinned 2026-06-19; revisit if Voyage
// changes pricing or the model is swapped). The first 200M tokens per account are free, so
// estimateCostUsd is a gross list-price UPPER bound that ignores the free allotment — real
// spend stays $0 until the account's lifetime usage outgrows 200M tokens.
const PRICE_PER_MTOK_USD = 0.12;

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
 *
 * `apiKey` is the Phase-8 injection seam: a caller without `process.env` (the Cloudflare
 * Worker) passes the key explicitly; omit it (or pass an empty string) and we fall back to
 * `getVoyageApiKey()` (the local-script / env path). An empty injected key is treated as
 * absent — not sent as `Bearer ` — so a misconfigured secret surfaces the env path's
 * friendly error instead of a silent 401. The key is never logged (no-secrets-in-logs rule).
 */
export async function embedRequest(
  input: string[],
  inputType: VoyageInputType,
  apiKey?: string,
): Promise<VoyageEmbedResponse> {
  const key = apiKey && apiKey.length > 0 ? apiKey : getVoyageApiKey();
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
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

  // Envelope validation + order-aligned extraction is the shared embedding contract; only
  // the provider name, dimension, and count are Voyage-specific.
  return parseEmbeddingResponse((await res.json()) as unknown, {
    provider: "Voyage",
    expectedDimensions: EMBED_DIMENSIONS,
    expectedCount: input.length,
  });
}
