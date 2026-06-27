/**
 * The embedder shape the embedding ranker depends on. Structurally a subset of
 * `@opusfinder/embeddings`'s `embed()` — the Voyage embedder delegates to it, the OpenAI
 * embedder implements it directly — so swapping providers for the comparison is
 * just passing a different `Embedder`. inputType carries Voyage's query/document asymmetry;
 * symmetric providers (OpenAI) ignore it.
 */
export type EmbedInputType = "query" | "document" | null;

/**
 * Maps input texts to one vector each, in input order. Token usage is intentionally NOT
 * surfaced — the harness scores ranking quality, not cost. The embeddings package's `embed()`
 * already returns usage to surface on the Voyage side.
 */
export type Embedder = (texts: string[], inputType: EmbedInputType) => Promise<number[][]>;
