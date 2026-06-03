import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { runScript } from "@opusfinder/shared/script";
import { isSourceName } from "@opusfinder/sources";

import { runDiscovery } from "../src/discover";

/**
 * Local slug-discovery run: seed → resolve → probe → upsert the live subset → reprobe → staleness
 * sweep, all under one source_runs row. Default (no args) is the BROADER pass over all covered sources.
 *
 *   pnpm discover [--source=<name>] [--limit=<n>] [--dry-run]
 *
 * `--dry-run` is a read-only preview (writes nothing). Moves to a Cloudflare Worker in Phase 8 —
 * `runDiscovery` is already argv-free for that.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const rawSource = args.find((a) => a.startsWith("--source="))?.slice("--source=".length);
  const rawLimit = args.find((a) => a.startsWith("--limit="))?.slice("--limit=".length);

  if (rawSource !== undefined && !isSourceName(rawSource)) {
    console.error(`Unknown --source=${rawSource}`);
    process.exitCode = 1; // NOT process.exit() — Windows libuv teardown crash
    return;
  }
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error("--limit must be a positive number");
      process.exitCode = 1;
      return;
    }
  }

  const db = createDb(getDatabaseUrl());
  await runDiscovery(db, { source: rawSource, limit, dryRun });
}

await runScript("Discover", main);
