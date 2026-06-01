import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { backfillJobEmbeddings, upsertCompany, upsertJobs } from "@opusfinder/db/repos";
import { embed, formatEmbedCost } from "@opusfinder/embeddings";
import { runScript } from "@opusfinder/shared/script";

import { fetchJobs } from "../src/greenhouse";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noEmbed = args.includes("--no-embed");
  const slug = args.find((a) => !a.startsWith("--"));
  if (!slug) {
    console.error("Usage: pnpm --filter @opusfinder/sources fetch:greenhouse <slug> [--no-embed]");
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

  // Embed this board's postings that still lack a vector — freshly inserted jobs plus any
  // whose content changed (upsertJobs nulls the embedding on a real change). Phase 4.
  // Skippable so keyless ingestion still works: embedding needs VOYAGE_API_KEY + tokens.
  if (noEmbed) {
    console.log("Skipping embedding (--no-embed).");
  } else if (!process.env.VOYAGE_API_KEY?.trim()) {
    console.log(
      "Skipping embedding: VOYAGE_API_KEY not set (add it to packages/embeddings/.env, " +
        "or pass --no-embed to silence this).",
    );
  } else {
    // Jobs are already persisted above; embedding is a best-effort follow-up. Isolate
    // its failure so a Voyage hiccup (429/5xx/network) doesn't make a successful ingest
    // report failure (exit 1) — the next run's inline embed or `pnpm embeddings:backfill`
    // picks up the still-NULL rows (idempotent).
    try {
      const { embedded, tokens } = await backfillJobEmbeddings(db, embed, {
        companyId,
        inputType: "document",
      });
      console.log(
        `Embedded ${embedded} job${embedded === 1 ? "" : "s"} (${formatEmbedCost(tokens)}).`,
      );
    } catch (err) {
      console.warn(
        `Warning: jobs persisted, but embedding failed: ${err instanceof Error ? err.message : String(err)}. ` +
          "Run `pnpm embeddings:backfill` to retry.",
      );
    }
  }
}

await runScript("Ingest", main);
