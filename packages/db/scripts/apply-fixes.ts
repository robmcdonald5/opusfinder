import { appendFileSync } from "node:fs";

import { Client } from "@neondatabase/serverless";
import { runScript } from "@opusfinder/shared/script";

import { getDataFixDatabaseUrl } from "../src/env";
import { applyPendingFixes, formatFixRun, readFixes, type FixClient } from "../src/fixes";

// Applies every pending packages/db/fixes file as the data_fixer role. Run by .github/workflows/data-fixes.yml
// (main only, DATA_FIX_DATABASE_URL from the data-fixes Environment); see fixes/README.md.
//
// neon-serverless (WebSocket) Client, not neon-http: a fix needs a real transaction around multi-statement SQL
// plus the record insert, which neon-http can't hold (same reason auth uses createAuthDb). A single Client, not
// a Pool, so the transaction stays on one connection and its NOTICEs can be collected.

/** Write the report to the Actions job summary when running in Actions. */
function writeSummary(markdown: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) appendFileSync(path, `${markdown}\n`);
}

await runScript("Data fixes", async () => {
  const { fixes, problems } = readFixes();
  if (problems.length > 0) {
    writeSummary(
      [
        "## Data fixes",
        "",
        "Not run: the fix files are invalid.",
        "",
        ...problems.map((p) => `- ${p}`),
      ].join("\n"),
    );
    throw new Error(`invalid fix files:\n${problems.join("\n")}`);
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
    let report: string;
    try {
      const run = await applyPendingFixes(db, fixes, process.env.GITHUB_SHA ?? null);
      report = formatFixRun(run);
      if (run.outcomes.some((o) => o.error !== undefined)) process.exitCode = 1;
    } catch (err) {
      report = `## Data fixes\n\nNothing applied: ${err instanceof Error ? err.message : String(err)}\n`;
      process.exitCode = 1;
    }
    console.log(report);
    writeSummary(report);
  } finally {
    await client.end();
  }
});
