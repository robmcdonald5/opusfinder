/**
 * The LLM-rerank `Ranker` for the eval harness — the SAME shared core the digest pipeline runs
 * (`rerankCandidates` from `@opusfinder/rerank`), wired here with a DETERMINISTIC stub call so the
 * committed report is byte-stable and the gate needs no API key. The real Haiku `generateObject` call
 * is wired by the digest pipeline; pass it to `llmRerankRanker(realCall)` to measure true rerank
 * quality on the labeled set. Imported dynamically by scripts/eval.ts's resolveRanker, so a plain
 * `pnpm eval` never loads `@opusfinder/rerank`.
 */
import { rerankCandidates, type RerankCall, type RerankCandidate } from "@opusfinder/rerank";

import { hashString, mulberry32 } from "../rng";
import type { Ranker } from "../types";

/**
 * A deterministic stand-in for the real LLM rerank call: scores each candidate from a stable hash of
 * (system, candidate id) → a 0.0–1.0 pseudo-score (the rubric's scale). Determinism keeps the committed
 * `llm-rerank` report from churning; profile-dependence (the `system` string embeds the profile) makes
 * different profiles produce different orderings, so it exercises the core like a real ranker would —
 * without a network call. NOT a quality signal: it proves the core (chunk → score → merge → backfill)
 * + the harness wiring.
 */
export const stubRerankCall: RerankCall = (system, candidates) => {
  const base = hashString(system);
  return Promise.resolve(
    candidates.map((c) => {
      const rng = mulberry32((base ^ hashString(String(c.id))) >>> 0);
      return { id: c.id, score: rng() };
    }),
  );
};

/**
 * Eval `Ranker` over the shared rerank core. The dataset's `candidateJobs` ARE the retrieved pool — the
 * digest retrieves the top-N from pgvector then reranks; in eval the labeled candidate set plays that
 * role — so this reranks them directly and returns the full ordering (`assertPermutation`-safe via the
 * core's backfill). `call` defaults to the deterministic stub.
 */
export function llmRerankRanker(call: RerankCall = stubRerankCall): Ranker {
  return async (profile, candidates) => {
    const input: RerankCandidate[] = candidates.map((j) => ({
      id: j.id,
      title: j.title,
      descriptionText: j.descriptionText,
    }));
    const { orderedIds } = await rerankCandidates(profile, input, call);
    return orderedIds;
  };
}
