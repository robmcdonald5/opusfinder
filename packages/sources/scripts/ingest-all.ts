import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { listCompanies, upsertCompany, upsertJobs } from "@opusfinder/db/repos";
import type { SourceName } from "@opusfinder/shared";
import { runScript } from "@opusfinder/shared/script";

import { fetchJobs, isSourceName } from "../src/adapters";
import { embedBoard, embedPolicy } from "./ingest-shared";

/**
 * Ingest every known company across all sources: iterate the `companies` rows, fetch +
 * normalize each board through its adapter, upsert, and (best-effort) embed. The Phase-6
 * multi-source ingestion entry point; the Phase-8 Worker cron will call the same path.
 *
 *   pnpm --filter @opusfinder/sources ingest:all [--no-embed] [--source=<name>]
 *
 * Seed companies first with `pnpm ingest <source> <slug>`. Each board is isolated in a
 * try/catch so one failure (a dead slug, a 5xx) doesn't halt the run — failures are logged
 * (Phase 7 will record them in source_runs).
 */

// Brief pace between boards so we don't hammer shared public ATS infra (Workable 429s on
// rapid sequential calls). Worker-compatible sleep.
const PACE_MS = 500;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noEmbed = args.includes("--no-embed");

  let source: SourceName | undefined;
  const rawSource = args.find((a) => a.startsWith("--source="))?.slice("--source=".length);
  if (rawSource !== undefined) {
    if (!isSourceName(rawSource)) {
      console.error(`Unknown --source=${rawSource}`);
      process.exitCode = 1;
      return;
    }
    source = rawSource;
  }

  const db = createDb(getDatabaseUrl());
  const list = await listCompanies(db, source ? { source } : {});
  if (list.length === 0) {
    console.log("No companies to ingest. Seed some with `pnpm ingest <source> <slug>` first.");
    return;
  }

  const policy = embedPolicy(noEmbed);
  if (policy.reason) console.log(policy.reason);
  console.log(`Ingesting ${list.length} compan${list.length === 1 ? "y" : "ies"}...`);

  let ok = 0;
  let failed = 0;
  let totalJobs = 0;
  let totalChanged = 0;

  for (const [i, company] of list.entries()) {
    if (i > 0) await sleep(PACE_MS);
    try {
      const normalized = await fetchJobs(company.source, company.slug);
      // Idempotent get-or-create returns the existing id; using the listed company (not
      // jobs[0]) keeps a valid-but-empty board recorded too.
      const companyId = await upsertCompany(db, company.slug, company.source);
      const { changed, total } = await upsertJobs(db, companyId, normalized);
      totalJobs += total;
      totalChanged += changed;
      ok++;
      console.log(`  ${company.source}:${company.slug} -> ${total} job(s), changed ${changed}`);
      if (policy.enabled && total > 0) await embedBoard(db, companyId);
    } catch (err) {
      failed++;
      console.warn(
        `  ${company.source}:${company.slug} FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(
    `Ingest-all done: ${ok}/${list.length} board(s) ok` +
      (failed > 0 ? `, ${failed} failed` : "") +
      `; ${totalJobs} job(s) persisted, ${totalChanged} changed.`,
  );
}

await runScript("IngestAll", main);
