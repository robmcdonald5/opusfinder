import { parseArgs } from "node:util";

import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import {
  coverageBySource,
  pairStatus,
  reportList,
  type ReportList,
  type ReportRow,
} from "@opusfinder/db/repos";
import { runScript } from "@opusfinder/shared/script";

import { PROMPT_VERSION } from "../src/index";

/**
 * How well the stored location strings cover active jobs, and the worklists: strings with no usable
 * place, low-confidence answers, places that failed the GeoNames check, and strings the model gave no
 * answer for, each by active-job count. Read-only.
 *
 *   pnpm locations:report [-- --limit 25]
 */
const LISTS: [ReportList, string][] = [
  ["no-place", "No usable place (no place, no remote country)"],
  ["low-confidence", "Low confidence"],
  ["unmatched", "Places that failed the GeoNames check"],
  ["unresolved", "No answer from the model"],
];

await runScript("locations:report", async () => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { limit: { type: "string" } },
  });
  const limit = values.limit && /^\d+$/.test(values.limit) ? Number(values.limit) : 25;
  const db = createDb(getDatabaseUrl());

  const status = await pairStatus(db, PROMPT_VERSION);
  console.log(
    `Pairs (prompt version ${PROMPT_VERSION}): ${status.active} active; ${status.missing} without a row, ` +
      `${status.stale} from another version, ${status.unresolved} with no answer.\n`,
  );

  console.log("Active on-site jobs with at least one place, by source:");
  let onsite = 0;
  let placed = 0;
  for (const c of await coverageBySource(db)) {
    onsite += c.onsite;
    placed += c.onsitePlaced;
    console.log(
      `  ${c.source.padEnd(16)} ${percent(c.onsitePlaced, c.onsite).padStart(6)}  (${c.onsitePlaced}/${c.onsite} on-site; ${c.remote} remote)`,
    );
  }
  console.log(
    `  ${"all".padEnd(16)} ${percent(placed, onsite).padStart(6)}  (${placed}/${onsite} on-site)\n`,
  );

  for (const [list, title] of LISTS) {
    const rows = await reportList(db, list, limit);
    console.log(`${title} — top ${limit} by active jobs: ${rows.length === 0 ? "none" : ""}`);
    for (const row of rows) console.log(`  ${formatRow(row, list)}`);
    console.log("");
  }
});

function formatRow(row: ReportRow, list: ReportList): string {
  const head = `${String(row.jobs).padStart(5)} jobs  ${row.companySlug} · ${JSON.stringify(row.raw)}`;
  if (list === "unmatched") {
    const failed = row.unmatched.map(
      (u) => `${[u.city, u.region, u.country].filter(Boolean).join(", ")} (${u.why})`,
    );
    return `${head} — ${failed.join("; ")}`;
  }
  return `${head} — ${row.reason ?? ""}`;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "—" : `${((100 * part) / whole).toFixed(1)}%`;
}
