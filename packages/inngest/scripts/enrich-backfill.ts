/**
 * Phase F4 enrichment backfill (4d) — fill every job whose `enriched_at` is still NULL with a structured
 * {@link JobEnrichment} (numeric YoE band + salary range) extracted from its title + description by a cached,
 * temperature-0 Haiku pass. Standalone + idempotent: a second run finds nothing; a row whose extraction threw
 * is left un-stamped and retried on the next run.
 *
 * NODE-only by design: the extractor reaches `@anthropic-ai/sdk`, which `guard:worker` forbids. The Worker
 * upserts jobs with `enriched_at` NULL and this script fills them — exactly the embedding-backfill split (the
 * Worker never passes `opts.embed`). Lives in @opusfinder/inngest because it needs both `@opusfinder/db` and
 * `@opusfinder/llm`, and inngest is the Node-side LLM orchestrator + the eventual home of a Phase-12 scheduled
 * fn (PHASE_F4_PLAN.md decision 5: standalone script now, promote to an Inngest fn when cadence lands).
 *
 * No filtering — this is store-and-observe; the salary/YoE WHERE clauses are the twice-gated F4-FILTER
 * follow-on. Needs DATABASE_URL (packages/db/.env) + ANTHROPIC_API_KEY (packages/llm/.env).
 *
 *   pnpm enrich:backfill
 */
import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { backfillJobEnrichment } from "@opusfinder/db/repos";
import { makeJobEnrichmentExtractor } from "@opusfinder/llm";
import { runScript } from "@opusfinder/shared/script";

async function main(): Promise<void> {
  const db = createDb(getDatabaseUrl());
  const extract = makeJobEnrichmentExtractor();
  const { enriched, failed } = await backfillJobEnrichment(db, extract);

  if (enriched === 0 && failed === 0) {
    console.log("No jobs need enrichment; nothing to do.");
    return;
  }
  const tail = failed > 0 ? ` ${failed} failed extraction (left un-stamped for the next run).` : "";
  console.log(`Enriched ${enriched} job${enriched === 1 ? "" : "s"}.${tail}`);
}

await runScript("EnrichBackfill", main);
