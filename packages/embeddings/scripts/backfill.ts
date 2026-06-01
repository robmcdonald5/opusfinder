import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { backfillJobEmbeddings } from "@opusfinder/db/repos";
import { runScript } from "@opusfinder/shared/script";

import { embed, formatEmbedCost } from "../src/index";

/**
 * Embed every job whose `embedding` is still NULL (the backlog + any reset by a content
 * change). Idempotent: a second run finds nothing and reports 0 — no double-embedding.
 * Needs DATABASE_URL (packages/db/.env) and VOYAGE_API_KEY (packages/embeddings/.env).
 */
async function main(): Promise<void> {
  const db = createDb(getDatabaseUrl());
  const { embedded, tokens } = await backfillJobEmbeddings(db, embed, { inputType: "document" });

  if (embedded === 0) {
    console.log("No jobs need embedding; nothing to do.");
    return;
  }
  console.log(`Embedded ${embedded} job${embedded === 1 ? "" : "s"} (${formatEmbedCost(tokens)}).`);
}

await runScript("Backfill", main);
