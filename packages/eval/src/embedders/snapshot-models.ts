/**
 * The snapshot's embedding models: voyage-4-large as the reference (what production runs; never a
 * contender) and the two challengers of the embedding head-to-head. Eval-only: production's
 * `@opusfinder/embeddings` is not involved in the challengers and is not changed by them.
 *
 * Every fact a comparison depends on is here, in one place the pool builder imports too: the id stored
 * beside each vector, the pinned host, the width, the list price, and how each side of the retrieval
 * (a job as a document, a profile as a query) is presented to the model.
 */
import type { ChunkLimits } from "@opusfinder/embeddings";

import type { Embedder, EmbedInputType } from "./types";

export type SnapshotInputType = Exclude<EmbedInputType, null>;

export interface MeteredEmbeddings {
  /** One vector per input, in input order. */
  embeddings: number[][];
  /** The provider's reported token usage for the request. */
  totalTokens: number;
  /** What the request cost, where the host reports it; otherwise spend is counted at the list price. */
  costUsd?: number;
}

export interface SnapshotModel {
  /** Stored beside every vector this model produces, as production's `embedding_model` is. */
  id: string;
  /** The model's name in object paths and on the command line. */
  slug: string;
  role: "reference" | "challenger";
  /** The one host the model is called on. Hosts may serve the same weights at different precision,
   *  so vectors from another host are not assumed interchangeable. */
  host: string;
  /** The width the vectors are stored at: the model's native width. */
  dimensions: number;
  /** List price, USD per 1M input tokens (read 2026-11-16). The spend guard counts at this price. */
  pricePerMTokUsd: number;
  /** Per-request bounds for the chunker. */
  limits: ChunkLimits;
  /** How each side is presented, in words, for the manifest. */
  presentation: Record<SnapshotInputType, string>;
  /** One request: `texts` must already respect `limits`. */
  embedBatch(texts: string[], inputType: SnapshotInputType): Promise<MeteredEmbeddings>;
}

export const SNAPSHOT_MODEL_SLUGS = [
  "voyage-4-large",
  "qwen3-embedding-8b",
  "nemotron-3-embed-8b",
] as const;
export type SnapshotModelSlug = (typeof SNAPSHOT_MODEL_SLUGS)[number];

export function isSnapshotModelSlug(value: string): value is SnapshotModelSlug {
  return (SNAPSHOT_MODEL_SLUGS as readonly string[]).includes(value);
}

/**
 * Resolve a snapshot model by slug. Dynamic imports keep each provider's key guard off runs that
 * don't use it (same reason as resolveEmbedder).
 */
export async function resolveSnapshotModel(slug: SnapshotModelSlug): Promise<SnapshotModel> {
  if (slug === "voyage-4-large") return (await import("./voyage-reference")).voyageReference;
  return (await import("./challengers")).challengerModel(slug);
}

/**
 * Mark a failed request the host may still have billed: it timed out, or it answered and the answer
 * couldn't be read or didn't pass the checks. A request the host refused with an error status, or
 * that never reached it, is not marked. The spend guard records the estimate of a marked failure.
 */
export function possiblyBilled(err: unknown): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  (error as { possiblyBilled?: true }).possiblyBilled = true;
  return error;
}

export function isPossiblyBilled(err: unknown): boolean {
  return err instanceof Error && (err as { possiblyBilled?: true }).possiblyBilled === true;
}

/** USD for `tokens` at the model's list price. */
export function modelCostUsd(
  model: Pick<SnapshotModel, "pricePerMTokUsd">,
  tokens: number,
): number {
  return (tokens / 1_000_000) * model.pricePerMTokUsd;
}

/** A snapshot model as a plain `Embedder`: chunked to its limits, usage dropped. */
export function asEmbedder(model: SnapshotModel): Embedder {
  return async (texts, inputType) => {
    if (inputType === null) {
      throw new Error(`${model.slug} needs "query" or "document"; it has no neutral input type.`);
    }
    const { chunkByLimits } = await import("@opusfinder/embeddings");
    const embeddings: number[][] = [];
    for (const chunk of chunkByLimits(texts, model.limits)) {
      embeddings.push(...(await model.embedBatch(chunk, inputType)).embeddings);
    }
    return embeddings;
  };
}
