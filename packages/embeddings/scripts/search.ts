import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { nearestJobs } from "@opusfinder/db/repos";
import { runScript } from "@opusfinder/shared/script";

import { embed } from "../src/index";

/**
 * Embed a query string and print the nearest jobs by cosine distance — the retrieval
 * smoke test. The query is embedded as `"query"` (the asymmetric counterpart
 * to jobs' `"document"`), then matched via the HNSW index.
 */
async function main(): Promise<void> {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    console.error('Usage: pnpm --filter @opusfinder/embeddings search "<query text>"');
    process.exitCode = 1;
    return;
  }

  const { embeddings } = await embed([query], { inputType: "query" });
  const vec = embeddings[0];
  if (!vec) throw new Error("Voyage returned no embedding for the query.");

  const db = createDb(getDatabaseUrl());
  const matches = await nearestJobs(db, vec, 10);

  if (matches.length === 0) {
    console.log(
      "No embedded jobs found. Run `pnpm embeddings:backfill` (or ingest with a key) first.",
    );
    return;
  }
  console.log(`Top ${matches.length} matches for: ${query}\n`);
  for (const m of matches) {
    console.log(`  [${String(m.id).padStart(5)}] dist ${m.distance.toFixed(4)}  ${m.title}`);
  }
}

await runScript("Search", main);
