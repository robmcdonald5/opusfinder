import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";
import { pruneOplog } from "../src/repos/prune-oplog";

/**
 * Phase G3g — the operational-log retention prune entry point. Thin wrapper over `pruneOplog`
 * (src/repos/prune-oplog.ts, where the registry + gate + loop + docs live). Mirrors prune-stale-jobs.ts:
 * runScript + createDb (neon-http).
 *
 * DRY-RUN BY DEFAULT — prints the eligible-row count per table and writes NOTHING. A real delete requires
 * the explicit `--apply` flag; eyeball the counts first. `digest_runs` is mostly inert by design (its
 * gate excludes any run a surviving digest still references — G3d's NO ACTION FK).
 *
 *   pnpm db:prune-oplog                                          (DRY RUN — counts only, writes nothing)
 *   pnpm --filter @opusfinder/db run prune-oplog -- --apply       (DELETE the eligible rows)
 */
await runScript("PruneOplog", async () => {
  const apply = process.argv.includes("--apply");
  const db = createDb(getDatabaseUrl());
  await pruneOplog(db, { apply });
});
