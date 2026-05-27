import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { backfillJobEmbeddings } from "@opusfinder/db/repos";

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

// Set exitCode rather than process.exit(): an abrupt exit while a Voyage/undici or
// neon-http socket handle is still closing trips a libuv assertion on Windows. Letting
// the event loop drain exits cleanly once those handles are released.
main().catch((err: unknown) => {
  console.error(`Backfill failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
