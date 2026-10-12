import { parseArgs } from "node:util";

import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { runScript } from "@opusfinder/shared/script";
import { isSourceName } from "@opusfinder/sources";

import { runDiscovery } from "../src/discover";
import { SEED_LANES } from "../src/seed";

/**
 * Local slug-discovery run: seed → resolve → probe → upsert the live subset → reprobe → staleness
 * sweep, all under one source_runs row. Default (no args) is the BROADER pass over all covered sources.
 *
 *   pnpm discover [--source=<name>] [--limit=<n>] [--lanes=<a,b>] [--dry-run]
 *
 * `--dry-run` is a read-only preview (writes nothing).
 */
async function main(): Promise<void> {
  // Strict (the parseArgs default): an unknown or value-less flag throws instead of falling through to the
  // broad all-source pass, whose deactivateStale sweep is UNSCOPED.
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      source: { type: "string" },
      limit: { type: "string" },
      lanes: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const dryRun = values["dry-run"] ?? false;

  const rawSource = values.source;
  if (rawSource !== undefined && !isSourceName(rawSource)) {
    console.error(`Unknown --source=${rawSource}`);
    process.exitCode = 1; // NOT process.exit() — Windows libuv teardown crash
    return;
  }

  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error("--limit must be a positive number");
      process.exitCode = 1;
      return;
    }
  }

  let lanes: string[] | undefined;
  if (values.lanes !== undefined) {
    lanes = values.lanes
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (lanes.length === 0) {
      console.error("--lanes needs at least one lane name, e.g. --lanes=outscal,hn");
      process.exitCode = 1;
      return;
    }
    const known = new Set(SEED_LANES.map((l) => l.name));
    const unknown = lanes.filter((l) => !known.has(l));
    if (unknown.length > 0) {
      console.error(`Unknown --lanes: ${unknown.join(", ")}. Known: ${[...known].join(", ")}`);
      process.exitCode = 1;
      return;
    }
  }

  const db = createDb(getDatabaseUrl());
  await runDiscovery(db, { source: rawSource, limit, lanes, dryRun });
}

await runScript("Discover", main);
