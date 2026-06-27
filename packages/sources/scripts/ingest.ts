import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { upsertCompany, upsertJobs } from "@opusfinder/db/repos";
import { runScript } from "@opusfinder/shared/script";

import { SOURCE_NAMES, adapters, fetchJobs, isSourceName } from "../src/adapters";
import { embedBoard, embedPolicy } from "./ingest-shared";

/**
 * Ad-hoc single-board ingestion across any ATS: fetch + normalize one board, upsert it
 * through @opusfinder/db, and (best-effort) embed the new/changed postings. (Named `ingest`,
 * not `fetch`, to avoid pnpm's built-in `fetch` command; pairs with `ingest:all`.)
 *
 *   pnpm --filter @opusfinder/sources ingest <source> <slug> [--no-embed]
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noEmbed = args.includes("--no-embed");
  const [source, slug] = args.filter((a) => !a.startsWith("--"));

  if (!source || !slug || !isSourceName(source)) {
    console.error(
      "Usage: pnpm --filter @opusfinder/sources ingest <source> <slug> [--no-embed]\n" +
        `  <source> one of: ${SOURCE_NAMES.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const jobs = await fetchJobs(source, slug);

  const db = createDb(getDatabaseUrl());
  // Seed the company from the canonical slug (not jobs[0]) so a valid-but-currently-empty
  // board is still recorded — ingest:all then re-checks it when it later posts jobs.
  const companyId = await upsertCompany(db, adapters[source].normalizeSlug(slug), source);
  const { changed, total } = await upsertJobs(db, companyId, jobs);

  const collapsed = jobs.length - total;
  console.log(
    `Upserted ${total} jobs for ${source}:"${slug}" (company_id=${companyId}): ` +
      `changed ${changed}, unchanged ${total - changed}` +
      (collapsed > 0 ? ` (collapsed ${collapsed} duplicate id${collapsed === 1 ? "" : "s"})` : ""),
  );

  const policy = embedPolicy(noEmbed);
  if (policy.reason) console.log(policy.reason);
  if (policy.enabled && total > 0) await embedBoard(db, companyId);
}

await runScript("Ingest", main);
