import type { Embedder } from "./types";

export type { Embedder, EmbedInputType } from "./types";

/**
 * Resolve an embedder by name via dynamic import — keeps each provider's deps (and its dotenv key
 * guard) off paths that don't use it: a `--ranker random` run loads neither, and a Voyage run never
 * touches the OpenAI key guard. Shared by scripts/eval.ts and scripts/compare.ts so both resolve
 * providers identically.
 */
export async function resolveEmbedder(name: string): Promise<Embedder> {
  if (name === "voyage") return (await import("./voyage")).voyageEmbedder;
  if (name === "openai") return (await import("./openai")).openaiEmbedder;
  throw new Error(`unknown embedder "${name}" (expected: voyage | openai).`);
}
