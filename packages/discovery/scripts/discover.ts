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
 * `--dry-run` is a read-only preview (writes nothing). Moves to a Cloudflare Worker in Phase 8 —
 * `runDiscovery` is already argv-free for that.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  // Accept BOTH `--flag=value` and `--flag value`. `present` stays true when the value is missing,
  // so a bare `--source` (or the space form `--source greenhouse`) is handled explicitly instead of
  // silently falling back to the broad all-source pass — which would run the UNSCOPED
  // deactivateStale sweep the operator never intended.
  const flagValue = (name: string): { present: boolean; value: string | undefined } => {
    const eq = `--${name}=`;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === undefined) continue;
      if (a === `--${name}`) {
        const next = args[i + 1];
        return {
          present: true,
          value: next !== undefined && !next.startsWith("--") ? next : undefined,
        };
      }
      if (a.startsWith(eq)) return { present: true, value: a.slice(eq.length) };
    }
    return { present: false, value: undefined };
  };

  const sourceFlag = flagValue("source");
  if (sourceFlag.present && sourceFlag.value === undefined) {
    console.error("--source needs a value, e.g. --source=greenhouse");
    process.exitCode = 1; // NOT process.exit() — Windows libuv teardown crash
    return;
  }
  // Narrow a plain `string | undefined` so isSourceName's type guard applies (a compound guard on
  // sourceFlag.value would not carry the SourceName narrowing through to runDiscovery's arg).
  const rawSource = sourceFlag.value;
  if (rawSource !== undefined && !isSourceName(rawSource)) {
    console.error(`Unknown --source=${rawSource}`);
    process.exitCode = 1;
    return;
  }

  const limitFlag = flagValue("limit");
  let limit: number | undefined;
  if (limitFlag.present) {
    limit = Number(limitFlag.value);
    if (limitFlag.value === undefined || !Number.isFinite(limit) || limit <= 0) {
      console.error("--limit must be a positive number");
      process.exitCode = 1;
      return;
    }
  }

  const lanesFlag = flagValue("lanes");
  let lanes: string[] | undefined;
  if (lanesFlag.present) {
    if (lanesFlag.value === undefined) {
      console.error("--lanes needs a value, e.g. --lanes=outscal,hn");
      process.exitCode = 1;
      return;
    }
    lanes = lanesFlag.value
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
