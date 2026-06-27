import type { Db } from "@opusfinder/db";
import { backfillJobEmbeddings } from "@opusfinder/db/repos";
import { embed, formatEmbedCost } from "@opusfinder/embeddings";

/**
 * Shared ingestion helpers for the fetch / ingest-all scripts — one definition of the
 * inline-embedding policy so the two entry points can't drift.
 */

/**
 * Decide whether to embed this run, and the one-line reason to print when it's skipped.
 * Resolved ONCE per run (not per board) so a multi-board run doesn't repeat the notice.
 */
export function embedPolicy(noEmbed: boolean): { enabled: boolean; reason?: string } {
  if (noEmbed) return { enabled: false, reason: "Skipping embedding (--no-embed)." };
  if (!process.env.VOYAGE_API_KEY?.trim()) {
    return {
      enabled: false,
      reason:
        "Skipping embedding: VOYAGE_API_KEY not set (add it to packages/embeddings/.env, " +
        "or pass --no-embed to silence this).",
    };
  }
  return { enabled: true };
}

/**
 * Best-effort inline embedding of a board's just-persisted postings: the
 * freshly-inserted jobs plus any whose content changed (upsertJobs nulls the embedding on a
 * real change). A Voyage failure is caught and warned — jobs are already persisted, so a
 * hiccup never fails the ingest; the next run's inline embed or `pnpm embeddings:backfill`
 * picks up the still-NULL rows (idempotent).
 */
export async function embedBoard(db: Db, companyId: number): Promise<void> {
  try {
    const { embedded, tokens } = await backfillJobEmbeddings(db, embed, {
      companyId,
      inputType: "document",
    });
    console.log(
      `Embedded ${embedded} job${embedded === 1 ? "" : "s"} (${formatEmbedCost(tokens)}).`,
    );
  } catch (err) {
    console.warn(
      `Warning: jobs persisted, but embedding failed: ${err instanceof Error ? err.message : String(err)}. ` +
        "Run `pnpm embeddings:backfill` to retry.",
    );
  }
}
