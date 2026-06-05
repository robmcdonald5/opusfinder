import { jobEmbeddingText } from "@opusfinder/db/repos";
import { composeProfileText } from "@opusfinder/shared";

import { cosineSimilarity } from "../cosine";
import type { Embedder } from "../embedders/types";
import type { Ranker } from "../types";

/**
 * Vector-retrieval ranker: embed the profile as a "query" and each candidate as a "document",
 * then order candidates by cosine similarity (descending). This is the SAME computation the
 * Phase-10 digest pipeline runs against the pgvector HNSW index — done IN MEMORY here over the
 * small labeled pool, so the Voyage-vs-OpenAI comparison is just two `embeddingRanker`s built
 * from different `Embedder`s, and the production `jobs.embedding` column is never touched.
 *
 * Jobs are composed with the shared `jobEmbeddingText` so eval embeds them identically to
 * ingestion — a divergence here would make the eval measure the wrong thing.
 *
 * Document vectors are cached per ranker instance, keyed by embed text, so a job that recurs
 * across examples (the labeled set reuses one board-wide candidate pool) is embedded ONCE per
 * run, not once per example — removing the dominant cost, paid document tokens multiplied by
 * example count. The cache lives in the closure, so it's per-provider (the comparison builds a
 * fresh `embeddingRanker` per provider) and dies with the process; only the per-example profile
 * "query" is always re-embedded.
 */
export function embeddingRanker(embed: Embedder): Ranker {
  const docCache = new Map<string, number[]>();
  return async (profile, candidates) => {
    // composeProfileText (@opusfinder/shared) is the single source of truth for the profile query
    // text — eval embeds profiles exactly as the Phase-9 ingest pipeline does.
    const profileVecs = await embed([composeProfileText(profile)], "query");
    const queryVec = profileVecs[0];
    if (!queryVec) throw new Error("embedder returned no vector for the profile.");

    const texts = candidates.map((j) => jobEmbeddingText(j));
    // Authoritative contentless guard (the dataset validator's is a lightweight, db-free mirror):
    // jobEmbeddingText is the document text the embedder sees, and the API 400s on "". A candidate
    // that composes to "" here means the validator's heuristic has drifted from the real composer —
    // fail with a clear message rather than an opaque provider error mid-run.
    const blankIdx = texts.findIndex((t) => t.trim() === "");
    if (blankIdx >= 0) {
      throw new Error(
        `candidate job ${candidates[blankIdx]?.id} composes to empty text via jobEmbeddingText; ` +
          `the dataset contentless guard has drifted from the embedding composition.`,
      );
    }
    const missing = [...new Set(texts.filter((t) => !docCache.has(t)))];
    if (missing.length > 0) {
      const fresh = await embed(missing, "document");
      if (fresh.length !== missing.length) {
        throw new Error(
          `embedder returned ${fresh.length} vectors for ${missing.length} document texts.`,
        );
      }
      missing.forEach((t, i) => docCache.set(t, fresh[i] as number[]));
    }

    return candidates
      .map((job, i) => ({
        id: job.id,
        score: cosineSimilarity(queryVec, docCache.get(texts[i] as string) as number[]),
      }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.id);
  };
}
