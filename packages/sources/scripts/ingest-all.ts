import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { embed } from "@opusfinder/embeddings";
import type { SourceName } from "@opusfinder/shared";
import { runScript } from "@opusfinder/shared/script";

import { isSourceName } from "../src/adapters";
import { runIngestion } from "../src/ingest";
import { embedPolicy, printBoard } from "./ingest-shared";

/**
 * Ingest every known company across all sources. A thin CLI shell over `runIngestion`
 * (packages/sources/src/ingest.ts) — the SAME library the Worker cron calls — so the CLI and
 * the cron can't drift. This script owns only the local concerns: argv parsing, the
 * `process.env`-backed embed policy, and the per-board console output (via `onBoard`);
 * `runIngestion` owns the per-board loop, the `source_runs` row, and the summary log.
 *
 *   pnpm --filter @opusfinder/sources ingest:all [--no-embed] [--source=<name>]
 *
 * Seed companies first with `pnpm ingest <source> <slug>`.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noEmbed = args.includes("--no-embed");

  let source: SourceName | undefined;
  const rawSource = args.find((a) => a.startsWith("--source="))?.slice("--source=".length);
  if (rawSource !== undefined) {
    if (!isSourceName(rawSource)) {
      console.error(`Unknown --source=${rawSource}`);
      process.exitCode = 1;
      return;
    }
    source = rawSource;
  }

  const policy = embedPolicy(noEmbed);
  if (policy.reason) console.log(policy.reason);

  const db = createDb(getDatabaseUrl());
  const counts = await runIngestion(db, {
    source,
    // The CLI preserves its prior behavior — ingest every company row, including any discovery
    // has deactivated (a manual run may want to re-check a dead board). The Worker cron opts
    // into `activeOnly: true`.
    activeOnly: false,
    pipeline: "ingestion-cli",
    // Inline-embed when the policy allows (key present + not --no-embed). The CLI relies on the
    // local VOYAGE_API_KEY (embedRequest's fallback); the Worker injects the key instead.
    embed: policy.enabled ? embed : undefined,
    onBoard: printBoard,
  });

  if (counts.companies === 0) {
    console.log("No companies to ingest. Seed some with `pnpm ingest <source> <slug>` first.");
  }
}

await runScript("IngestAll", main);
