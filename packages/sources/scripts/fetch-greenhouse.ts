import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { upsertCompany, upsertJobs } from "@opusfinder/db/repos";

import { fetchJobs } from "../src/greenhouse";

async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: pnpm --filter @opusfinder/sources fetch:greenhouse <slug>");
    process.exitCode = 1;
    return;
  }

  const jobs = await fetchJobs(slug);

  // Empty board: nothing to persist, and no canonical company slug to derive a
  // companies row from. Bail before opening a DB connection.
  const first = jobs[0];
  if (!first) {
    console.log(`No jobs returned for "${slug}"; nothing to persist.`);
    return;
  }

  const db = createDb(getDatabaseUrl());
  // Every posting from one board carries the same canonical (branded) company
  // slug + source — take them from the first job rather than re-deriving the
  // per-ATS canonical form here (that rule lives in the Greenhouse adapter).
  const companyId = await upsertCompany(db, first.companySlug, first.source);
  const { changed, total } = await upsertJobs(db, companyId, jobs);

  const collapsed = jobs.length - total;
  console.log(
    `Upserted ${total} jobs for "${slug}" (company_id=${companyId}): ` +
      `changed ${changed}, unchanged ${total - changed}` +
      (collapsed > 0 ? ` (collapsed ${collapsed} duplicate id${collapsed === 1 ? "" : "s"})` : ""),
  );
}

// Set exitCode rather than calling process.exit(): an abrupt exit while an undici
// socket handle is still closing trips a libuv assertion on Windows. Letting the
// event loop drain exits cleanly once fetchJobs / the neon-http driver have
// released their handles.
main().catch((err: unknown) => {
  console.error(`Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
