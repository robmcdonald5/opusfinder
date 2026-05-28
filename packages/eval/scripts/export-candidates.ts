/**
 * Dump real ingested jobs from Neon to a working JSON file, so the labeled candidate pools in
 * dataset.jsonl are built from REAL postings (the Phase-5 requirement) rather than invented.
 * Read-only — a plain SELECT, no writes. The output is a hand-curation aid: when authoring an
 * example you copy the relevant subset (relevant + distractor jobs) into dataset.jsonl as the
 * candidate pool, then label `expectedGoodIds`. The export is gitignored; only the curated,
 * frozen dataset is committed.
 *
 *   pnpm --filter @opusfinder/eval export:candidates                 # all jobs -> data/candidates-export.json
 *   pnpm --filter @opusfinder/eval export:candidates -- --limit 200
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { jobs } from "@opusfinder/db/schema";

import { getFlag } from "../src/cli";
import { PKG_ROOT } from "../src/runner";

const DEFAULT_LIMIT = 500;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitFlag = getFlag(args, "--limit");
  const limit = limitFlag === undefined ? DEFAULT_LIMIT : Number(limitFlag);
  // Reject 0 / negative / non-integer up front: each would otherwise reach Postgres's LIMIT
  // verbatim and either export nothing (misread later as "missing export") or throw an opaque
  // driver error. One parse, one validated value — no second default downstream.
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`--limit must be a positive integer (got "${limitFlag}").`);
  }
  const out = getFlag(args, "--out") ?? join(PKG_ROOT, "data", "candidates-export.json");

  const db = createDb(getDatabaseUrl());
  const rows = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      descriptionText: jobs.descriptionText,
      locations: jobs.locations,
      remote: jobs.remote,
      source: jobs.source,
      companyId: jobs.companyId,
    })
    .from(jobs)
    .orderBy(jobs.id)
    .limit(limit);

  writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`, "utf8");

  // The export is meant to be the WHOLE board; exactly `limit` rows means we likely hit the cap
  // and silently dropped the rest (a too-small pool later fails build:dataset with a confusing
  // "good id N is not in the export"). Surface it — no silent truncation.
  if (rows.length === limit) {
    console.error(
      `WARNING: hit the --limit cap of ${limit}; more jobs may exist. Re-run with a higher --limit.`,
    );
  }

  // Summary to stderr so stdout could be piped if ever wanted; counts only, no PII.
  const byCompany = new Map<number, number>();
  for (const r of rows) byCompany.set(r.companyId, (byCompany.get(r.companyId) ?? 0) + 1);
  console.error(`Exported ${rows.length} jobs across ${byCompany.size} companies to ${out}.`);
  console.error(
    `Sample titles: ${rows
      .slice(0, 8)
      .map((r) => r.title)
      .join(" | ")}`,
  );
}

// Set exitCode (not process.exit) so the neon-http fetch sockets drain — Windows teardown caveat.
main().catch((err: unknown) => {
  console.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
