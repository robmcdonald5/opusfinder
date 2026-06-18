import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";
import { pruneStaleJobs } from "../src/repos/prune";

/**
 * Phase G2b — the TTL hard-delete prune entry point. Thin wrapper over `pruneStaleJobs` (src/repos/prune.ts,
 * where the eligibility gate + loop + docs live). Mirrors reclaim-raw.ts: runScript + createDb (neon-http).
 *
 * DRY-RUN BY DEFAULT (decision 6) — prints the closed_total / closed_old / prunable breakdown and writes
 * NOTHING. A real, IRREVERSIBLE delete (decision 3) requires the explicit `--apply` flag; eyeball the
 * `prunable` count first (decision 1). prunable is 0 until F2_ENFORCE is live (no closes → nothing to
 * prune; G1 went enforce-on 2026-06-18). VACUUM is out of band — the script reminds the owner after a run.
 *
 * NB `prune` is a reserved pnpm built-in, so the script is named `prune-stale` and invoked via `run`:
 *   pnpm db:prune                                          (DRY RUN — count only, writes nothing)
 *   pnpm --filter @opusfinder/db run prune-stale -- --apply (DELETE the prunable rows; then VACUUM)
 */
await runScript("PruneStaleJobs", async () => {
  const apply = process.argv.includes("--apply");
  const db = createDb(getDatabaseUrl());
  await pruneStaleJobs(db, { apply });
});
