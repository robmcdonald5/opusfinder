import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { upsertCompany } from "@opusfinder/db/repos";
import { embed } from "@opusfinder/embeddings";
import { runScript } from "@opusfinder/shared/script";

import { SOURCE_NAMES, adapters, fetchJobs, isSourceName } from "../src/adapters";
import { runIngestion } from "../src/ingest";
import { embedPolicy, printBoard } from "./ingest-shared";

/**
 * Ad-hoc single-board ingestion across any ATS: record the board, then ingest it through `runIngestion`
 * — the path `ingest:all` and the cron take (presence, revival, lifecycle sweep, best-effort embed) —
 * under its own `ingestion-cli` run row. (Named `ingest`, not `fetch`, to avoid pnpm's built-in `fetch`
 * command; pairs with `ingest:all`.)
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

  // Fetch the first page before recording the board, so a slug that can't be fetched (a typo) leaves no
  // company row behind; a valid-but-currently-empty board is still recorded.
  await fetchJobs(source, slug, { maxItems: 1 });

  const policy = embedPolicy(noEmbed);
  if (policy.reason) console.log(policy.reason);

  const db = createDb(getDatabaseUrl());
  const companyId = await upsertCompany(db, adapters[source].normalizeSlug(slug), source);
  const counts = await runIngestion(db, {
    // The id-keyset chunk holding exactly this board, deactivated or not.
    afterId: companyId - 1,
    limit: 1,
    activeOnly: false,
    pipeline: "ingestion-cli",
    embed: policy.enabled ? embed : undefined,
    onBoard: printBoard,
  });
  if (counts.failed > 0) process.exitCode = 1;
}

await runScript("Ingest", main);
