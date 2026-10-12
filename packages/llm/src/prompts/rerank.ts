import { z } from "zod";

import { jobText, TITLE_CHARS } from "./job-text";

/**
 * The OUTPUT contract + candidate renderer for the rerank call. The scoring RUBRIC and the
 * chunk/merge/backfill orchestration live in `@opusfinder/rerank` (shared with the eval harness); this
 * file holds only what the real LLM call needs that `@opusfinder/rerank` deliberately stays free of:
 * the structured-output schema for `generateObject`, and how a candidate chunk is rendered into the
 * user message.
 */

/** Structured output for the rerank call: one 0.0–1.0 relevance score per candidate id (the scale the
 *  `@opusfinder/rerank` rubric defines). The core merges these across chunks and backfills omissions.
 *  The bounds fail a chunk answered on another scale (0–10, 0–100), which the caller leaves unscored;
 *  without them the core's clamp would turn every score in it into 1.0. */
export const RerankScoresSchema = z.object({
  scores: z
    .array(
      z.object({
        id: z.number().describe("The candidate job id, exactly as given in the list."),
        score: z
          .number()
          .min(0)
          .max(1)
          .describe("Relevance from 0.0 to 1.0 (higher = better), per the system rubric."),
      }),
    )
    .describe("One entry per job in the provided candidate list."),
});

export type RerankScores = z.infer<typeof RerankScoresSchema>;

/**
 * Render a candidate chunk into the rerank user message — one `<job id="…">` block per candidate (title,
 * then description) for the system rubric to score. Each description is cut to `descriptionChars` to
 * keep the variable tail small relative to the cached system+profile prefix. Postings usually open with
 * a company intro, so the default cut often ends before the requirements the rubric weighs most.
 */
export function renderRerankCandidates(
  candidates: { id: number; title: string; descriptionText: string }[],
  opts: { descriptionChars?: number } = {},
): string {
  const max = opts.descriptionChars ?? 1500;
  const blocks = candidates.map(
    (c) =>
      `<job id="${c.id}">\n${jobText(c.title, TITLE_CHARS)}\n${jobText(c.descriptionText, max)}\n</job>`,
  );
  return `Score each of the following ${candidates.length} job posting(s) for this candidate. Return a score for every job id.\n\n${blocks.join(
    "\n\n",
  )}`;
}
