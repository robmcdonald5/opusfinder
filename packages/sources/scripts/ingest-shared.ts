import { formatEmbedCost } from "@opusfinder/embeddings";

import type { IngestBoardResult } from "../src/ingest";

/**
 * Shared helpers for the ingest / ingest-all scripts — the inline-embedding policy and the per-board
 * console line, defined once so the two entry points can't drift.
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

/** `runIngestion`'s `onBoard` hook for the CLIs: one real-time line per board (the Worker stays quiet). */
export function printBoard(board: IngestBoardResult): void {
  if (board.skipped) {
    console.log(`  ${board.source}:${board.slug} skipped (${board.skipped})`);
    return;
  }
  if (!board.ok) {
    console.warn(`  ${board.source}:${board.slug} FAILED: ${board.error}`);
    return;
  }
  // The not-written postings are printed so a board whose every detail fetch failed doesn't read as
  // an empty board ("0 job(s)").
  console.log(
    `  ${board.source}:${board.slug} -> ${board.jobs} job(s), changed ${board.changed}` +
      (board.hydrateSkipped > 0
        ? `, ${board.hydrateSkipped} not written (detail fetch failed)`
        : "") +
      (board.embedded > 0
        ? `, embedded ${board.embedded} (${formatEmbedCost(board.embedTokens)})`
        : "") +
      (board.error ? ` [embed failed: ${board.error}]` : ""),
  );
}
