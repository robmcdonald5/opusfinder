import { desc } from "drizzle-orm";

import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";
import { sourceRuns } from "../src/schema";

/**
 * Print the most recent `source_runs` rows (default 5) — pipeline health at a glance. Shows only run
 * metadata (pipeline / source / status / counts / timestamps / error sample); the error sample is
 * truncated + secret-free by construction, so nothing sensitive is echoed.
 *
 *   pnpm --filter @opusfinder/db runs [N]
 */
await runScript("ShowRuns", async () => {
  const limitArg = Number(process.argv[2]);
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.trunc(limitArg) : 5;

  const db = createDb(getDatabaseUrl());
  const rows = await db.select().from(sourceRuns).orderBy(desc(sourceRuns.startedAt)).limit(limit);

  if (rows.length === 0) {
    console.log("(no source_runs rows)");
    return;
  }
  for (const r of rows) {
    console.log(
      `#${r.id} ${r.pipeline}${r.source ? `:${r.source}` : ""} [${r.status}] ` +
        `started=${formatTs(r.startedAt)} finished=${formatTs(r.finishedAt, "(running)")} ` +
        `counts=${JSON.stringify(r.counts)}` +
        (r.errorSample ? ` error=${r.errorSample}` : ""),
    );
  }
});

/** ISO timestamp for a Date/string column value; `fallback` for a NULL (e.g. an unfinished run). */
function formatTs(value: Date | string | null, fallback = "?"): string {
  if (value === null) return fallback;
  return value instanceof Date ? value.toISOString() : String(value);
}
