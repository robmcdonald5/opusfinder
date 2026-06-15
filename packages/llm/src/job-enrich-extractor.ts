import { type JobEnrichment, jobEnrichmentText } from "@opusfinder/shared";

import { generateObject } from "./generate-object";
import { JOB_ENRICH_SYSTEM, JobEnrichmentSchema } from "./prompts/job-enrich";
import type { ModelAlias } from "./provider";

/**
 * Build the production job-enrichment extractor (Phase F4): compose the job's text ({@link jobEnrichmentText})
 * and call a cached, temperature-0 `generateObject` with the {@link JOB_ENRICH_SYSTEM} prompt + the
 * {@link JobEnrichmentSchema} (the buildRerank DI pattern, inngest/src/deps.ts). The ONE place the prompt +
 * schema meet the SDK; both the Node-side backfill and the eval's live pass reuse this single factory (so
 * they share one code path). Returns a plain `(job) => Promise<JobEnrichment>` (structurally the db
 * `ExtractFn`), so callers inject it WITHOUT `@opusfinder/db` importing the LLM stack. NODE/server-only:
 * `generateObject` reaches `@anthropic-ai/sdk`, which `guard:worker` forbids.
 *
 * `temperature: 0` for grounded, repeatable extraction (the cv-extract posture: determinism beats creativity).
 * `cacheSystem` is best-effort — the small enrich prompt likely sits below Haiku's ~4096-token cache floor, so
 * it is a silent no-op (do NOT treat cache reads as a signal here). The default 2048 maxOutputTokens is ample
 * for the ~6-field JSON. Model defaults to `'haiku'`; pass `'sonnet'` for the F4-MODEL accuracy spot-check.
 * `generateObject` THROWS on truncation/invalid JSON — the backfill loop catches it and leaves the row
 * un-stamped for the next run (PHASE_F4_PLAN.md decision 6).
 */
export function makeJobEnrichmentExtractor(
  opts: { model?: ModelAlias } = {},
): (job: { title: string; descriptionText: string }) => Promise<JobEnrichment> {
  const model = opts.model ?? "haiku";
  return async (job) => {
    const { object } = await generateObject({
      model,
      system: JOB_ENRICH_SYSTEM,
      cacheSystem: true,
      schema: JobEnrichmentSchema,
      messages: [{ role: "user", content: jobEnrichmentText(job) }],
      temperature: 0,
    });
    return object;
  };
}
