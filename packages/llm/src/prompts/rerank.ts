import { z } from "zod";

/**
 * The OUTPUT contract + candidate renderer for the Phase-10 rerank call. The scoring RUBRIC and the
 * chunk/merge/backfill orchestration live in `@opusfinder/rerank` (shared with the eval harness); this
 * file holds only what the real LLM call needs that `@opusfinder/rerank` deliberately stays free of:
 * the structured-output schema for `generateObject`, and how a candidate chunk is rendered into the
 * user message. The digest pipeline (Phase 10f) wires the real call as
 * `(system, candidates) => generateObject({ model: 'haiku', system, cacheSystem: true,
 *   schema: RerankScoresSchema, messages: [{ role: 'user', content: renderRerankCandidates(candidates) }] })`
 * then maps the result to `RerankScore[]`.
 */

/** Structured output for the rerank call: one 0.0–1.0 relevance score per candidate id (the scale the
 *  `@opusfinder/rerank` rubric defines). The core merges these across chunks and backfills omissions. */
export const RerankScoresSchema = z.object({
  scores: z
    .array(
      z.object({
        id: z.number().describe("The candidate job id, exactly as given in the list."),
        score: z.number().describe("Relevance from 0.0 to 1.0 (higher = better), per the system rubric."),
      }),
    )
    .describe("One entry per job in the provided candidate list."),
});

export type RerankScores = z.infer<typeof RerankScoresSchema>;

/**
 * Render a candidate chunk into the rerank user message — a compact numbered list the system rubric
 * scores. Each description is truncated (ranking needs the title + a description excerpt, not full JD
 * fidelity) to keep the variable tail small relative to the cached system+profile prefix.
 */
export function renderRerankCandidates(
  candidates: { id: number; title: string; descriptionText: string }[],
  opts: { descriptionChars?: number } = {},
): string {
  const max = opts.descriptionChars ?? 1500;
  const lines = candidates.map((c) => {
    const desc =
      c.descriptionText.length > max ? `${c.descriptionText.slice(0, max)}…` : c.descriptionText;
    return `[job ${c.id}] ${c.title}\n${desc}`;
  });
  return `Score each of the following ${candidates.length} job posting(s) for this candidate. Return a score for every job id.\n\n${lines.join(
    "\n\n---\n\n",
  )}`;
}
