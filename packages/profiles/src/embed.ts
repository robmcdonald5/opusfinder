import type { ProfileEmbedFn } from "./types";

/**
 * Embed a single profile "query" text and return its vector + token usage. Centralizes the
 * unwrap-and-validate that both the ingest pipeline and the restructure seam need: fail loudly if the
 * embedder returned nothing usable — Voyage 400s on an empty input, and a partial/empty response would
 * otherwise be persisted as a broken vector. Keeping it in one place means the empty-vector guard
 * can't drift between the two callers.
 */
export async function embedQuery(
  embed: ProfileEmbedFn,
  text: string,
): Promise<{ vector: number[]; usage: { totalTokens: number } }> {
  const { embeddings, usage } = await embed([text], { inputType: "query" });
  const vector = embeddings[0];
  if (!vector || vector.length === 0) {
    throw new Error("embed() returned no usable vector for the profile text");
  }
  return { vector, usage };
}
