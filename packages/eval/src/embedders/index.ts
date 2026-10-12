import type { Embedder } from "./types";

export type { Embedder, EmbedInputType } from "./types";

/**
 * Resolve an embedder by name via dynamic import — keeps each provider's deps (and its dotenv key
 * guard) off paths that don't use it: a `--ranker random` run loads neither, and a Voyage run never
 * touches the OpenAI key guard. Shared by scripts/eval.ts and scripts/compare.ts so both resolve
 * providers identically. `model` is the provider's model id, recorded in the report.
 */
export async function resolveEmbedder(
  name: string,
): Promise<{ embedder: Embedder; model: string }> {
  if (name === "voyage") {
    const { voyageEmbedder, VOYAGE_MODEL } = await import("./voyage");
    return { embedder: voyageEmbedder, model: VOYAGE_MODEL };
  }
  if (name === "openai") {
    const { openaiEmbedder, OPENAI_MODEL } = await import("./openai");
    return { embedder: openaiEmbedder, model: OPENAI_MODEL };
  }
  throw new Error(`unknown embedder "${name}" (expected: voyage | openai).`);
}
