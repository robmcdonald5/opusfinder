import { appendFileSync } from "node:fs";

import { Client } from "@neondatabase/serverless";
import { runScript } from "@opusfinder/shared/script";

import { getDataFixDatabaseUrl } from "../src/env";
import {
  applyPendingFixes,
  formatFixRun,
  readFixes,
  type FixClient,
  type FixRun,
} from "../src/fixes";

// Applies every pending packages/db/fixes file as the data_fixer role. Run by .github/workflows/data-fixes.yml
// (main only, DATA_FIX_DATABASE_URL from the data-fixes Environment); see fixes/README.md.
//
// neon-serverless (WebSocket) Client, not neon-http: a fix needs a real transaction around multi-statement SQL
// plus the record insert, which neon-http can't hold (same reason auth uses createAuthDb). A single Client, not
// a Pool, so the transaction stays on one connection and its NOTICEs can be collected.

async function applyAll(): Promise<FixRun> {
  const { fixes, problems } = readFixes();
  if (problems.length > 0) {
    throw new Error(`the fix files are invalid:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  }
  const client = new Client(getDataFixDatabaseUrl());
  const notices: string[] = [];
  client.on("notice", (n) => notices.push(n.message ?? ""));
  await client.connect();
  try {
    const db: FixClient = {
      async query(sql, params) {
        // A multi-statement simple query resolves to one result per statement.
        const res: unknown = await client.query(sql, params);
        const last = Array.isArray(res) ? res.at(-1) : res;
        return (last as { rows?: Record<string, unknown>[] } | undefined)?.rows ?? [];
      },
      takeNotices: () => notices.splice(0),
    };
    return await applyPendingFixes(db, fixes, process.env.GITHUB_SHA ?? null);
  } finally {
    await client.end();
  }
}

// Every outcome, including a failure before any fix runs (bad files, the secret unset, a refused connection),
// lands in the log AND the Actions job summary.
await runScript("Data fixes", async () => {
  let report: string;
  try {
    const run = await applyAll();
    report = formatFixRun(run);
    if (run.outcomes.some((o) => o.error !== undefined)) process.exitCode = 1;
  } catch (err) {
    report = formatFixRun({ error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  }
  console.log(report);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${report}\n`);
});
