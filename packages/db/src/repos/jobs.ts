/**
 * Persistence for companies + jobs. Functional style: the Drizzle client is
 * injected (no module-level singleton), matching `createDb()` in ../client.
 *
 * Both upserts are idempotent. `upsertCompany` is get-or-create; `upsertJobs`
 * dedupes the batch, then only advances `updated_at` when a job's content
 * actually changed, so re-ingesting an unchanged board is a no-op.
 */
import { and, type AnyColumn, eq, gt, sql, type SQL } from "drizzle-orm";

import type { CompanySlug, NormalizedJob, SourceName } from "@opusfinder/shared";

import type { Db } from "../client";
import { companies, jobs } from "../schema";
import { NUL, signatureSql, stripNul } from "./sql";

/** One row of the companies table, as the ingestion driver needs it (id + identity). */
export interface CompanyRow {
  id: number;
  slug: CompanySlug;
  source: SourceName;
}

/**
 * List companies to ingest (id + canonical slug + source), oldest id first. Slugs come back
 * already branded (the column is `$type<CompanySlug>()`) and in their platform-canonical form
 * — stored post-`normalizeSlug` — so the driver requests them exactly as ingestion expects.
 * Optionally scoped to one `source` (for a per-source pass) and/or to `activeOnly` rows —
 * the Phase-8 Worker cron sets `activeOnly: true` to skip boards discovery has deactivated
 * (Phase-7 deferred #5); it defaults falsey so existing callers are unchanged. `afterId` +
 * `limit` form an id-keyset cursor (`WHERE id > afterId ORDER BY id LIMIT limit`) for the
 * Phase-8 chunked-cron lane — the chunk is built in SQL, not by loading the whole table and
 * slicing in memory. Used by the all-companies ingestion path (CLI + the Phase-8 Worker cron).
 */
export function listCompanies(
  db: Db,
  opts: { source?: SourceName; activeOnly?: boolean; afterId?: number; limit?: number } = {},
): Promise<CompanyRow[]> {
  const conditions: SQL[] = [];
  if (opts.source) conditions.push(eq(companies.source, opts.source));
  if (opts.activeOnly) conditions.push(eq(companies.active, true));
  if (opts.afterId !== undefined) conditions.push(gt(companies.id, opts.afterId));
  const query = db
    .select({ id: companies.id, slug: companies.slug, source: companies.source })
    .from(companies)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(companies.id);
  return opts.limit !== undefined ? query.limit(opts.limit) : query;
}

/**
 * Get-or-create the company for `(slug, source)` and return its id.
 *
 * The no-op `set` (slug ← its own excluded value) makes the conflicting row
 * "affected" so `RETURNING` yields the id even when the company already exists —
 * a bare `onConflictDoNothing` returns no rows on conflict. It writes nothing
 * meaningful, so `companies.updated_at` is left untouched.
 */
export async function upsertCompany(
  db: Db,
  slug: CompanySlug,
  source: SourceName,
): Promise<number> {
  const rows = await db
    .insert(companies)
    .values({ slug, source })
    .onConflictDoUpdate({
      target: [companies.slug, companies.source],
      set: { slug: sql`excluded.slug` },
    })
    .returning({ id: companies.id });

  const row = rows[0];
  if (!row) {
    throw new Error(`upsertCompany returned no row for ${source}:${slug}`);
  }
  return row.id;
}

/**
 * Batch-upsert a board's jobs in a single INSERT ... ON CONFLICT statement
 * (one HTTP round-trip on neon-http). Conflict key is `(source, external_id)`.
 *
 * Returns `{ changed, total }`: `total` is the count of DISTINCT jobs after
 * de-duplication; `changed` is how many were inserted or updated (rows whose
 * content was unchanged are skipped by `setWhere` and not returned). The caller
 * reports `unchanged = total - changed` and `collapsed = input.length - total`.
 */
export async function upsertJobs(
  db: Db,
  companyId: number,
  list: NormalizedJob[],
): Promise<{ changed: number; total: number }> {
  // Collapse duplicate (source, external_id) BEFORE the batch: a single
  // INSERT ... ON CONFLICT cannot affect the same conflict key twice (Postgres
  // raises 21000), and a board can repeat a posting id (cross-listed roles) or a
  // future source may reuse ids. Last occurrence wins; richer merging of
  // duplicates (e.g. multi-location postings) is an adapter concern, not here.
  const deduped = new Map<string, NormalizedJob>();
  for (const job of list) {
    deduped.set(JSON.stringify([job.source, job.externalId]), job);
  }
  // Guard the empty case: `INSERT ... VALUES` with no rows is invalid SQL.
  if (deduped.size === 0) return { changed: 0, total: 0 };

  const values = [...deduped.values()].map((job) => {
    // Strip U+0000 from anything bound for text/jsonb (Postgres rejects it).
    const title = job.title.replaceAll(NUL, "");
    const descriptionText = job.descriptionText.replaceAll(NUL, "");
    return {
      externalId: job.externalId,
      companyId,
      source: job.source,
      title,
      descriptionText,
      // Sort to a canonical order on write. `locations` is compared as an ORDER-SENSITIVE
      // jsonb array in setWhere below; a multi-location source emitting the same offices in a
      // different order across ingests would otherwise report a spurious "changed" every run.
      // runAdapter already canonicalizes the in-memory job's locations, so on the ingestion
      // path this is a no-op — it stays here as the defense for any direct upsertJobs caller.
      // Order isn't semantically meaningful for ATS locations (the original is kept on `raw`).
      locations: [...job.locations].map((l) => l.replaceAll(NUL, "")).sort(),
      remote: job.remote,
      applyUrl: job.applyUrl.replaceAll(NUL, ""),
      postedAt: job.postedAt,
      raw: stripNul(job.raw),
      // content_signature (Phase F1): md5 over the SAME normalized title+desc, computed SQL-side
      // from the bound (NUL-stripped) values via the ONE signatureSql definition — byte-identical to
      // the ON CONFLICT SET and the F1d backfill, so an insert and any later re-ingest/backfill of the
      // same content always produce the same signature. (embedding omitted — populated in Phase 4.)
      contentSignature: signatureSql(sql`${title}`, sql`${descriptionText}`),
    };
  });

  // The content-derived columns — the Phase-4 `embedding` and the Phase-F4 enrichment band (yoe_*/salary_*) +
  // the enriched_at SENTINEL — all reset to NULL when (and only when) title/description_text change, so the
  // backfill re-derives them next pass; any other (setWhere) churn KEEPS the existing value (re-embedding /
  // re-extracting identical prose is wasted work + tokens). One helper so every branch is provably identical
  // and reads ${jobs.<col>} (the EXISTING row), NEVER excluded.<col>: the INSERT VALUES omits these derived
  // columns, so excluded.* is the column DEFAULT (NULL) and an `ELSE excluded.<col>` would silently NULL every
  // already-derived row on every non-content churn. (content_signature is the exception — it is RECOMPUTED,
  // not preserved, so it stays an unconditional rewrite rather than this preserve-or-null CASE.)
  const nullIfContentChanged = (col: AnyColumn): SQL => sql`CASE
          WHEN ${jobs.title} IS DISTINCT FROM excluded.title
            OR ${jobs.descriptionText} IS DISTINCT FROM excluded.description_text
          THEN NULL
          ELSE ${col}
        END`;

  const updated = await db
    .insert(jobs)
    .values(values)
    .onConflictDoUpdate({
      target: [jobs.source, jobs.externalId],
      // Write every comparable field + company_id, refresh write-only fields
      // (posted_at, raw), conditionally reset the derived embedding, and advance
      // updated_at. INVARIANT: every column tested
      // in `setWhere` below must also appear here — a field compared but not
      // written would make every re-ingest look "changed" forever.
      set: {
        companyId: sql`excluded.company_id`,
        title: sql`excluded.title`,
        descriptionText: sql`excluded.description_text`,
        locations: sql`excluded.locations`,
        remote: sql`excluded.remote`,
        applyUrl: sql`excluded.apply_url`,
        postedAt: sql`excluded.posted_at`,
        raw: sql`excluded.raw`,
        // The embedding is derived from title + description_text ONLY (see nullIfContentChanged above): reset
        // it on a content change so the backfill / inline-embed step re-embeds, keep it on any other churn.
        embedding: nullIfContentChanged(jobs.embedding),
        // content_signature (Phase F1): rewritten unconditionally from excluded title+desc via the
        // ONE signatureSql definition (the setWhere note below explains why it is written but NOT
        // also tested). Byte-identical to the INSERT VALUES above and the F1d backfill.
        contentSignature: signatureSql(sql`excluded.title`, sql`excluded.description_text`),
        // Phase F4 enrichment (yoe_*/salary_*) + the enriched_at sentinel: reset on the title/description
        // trigger (NOT the broader setWhere), written but NOT tested in setWhere — derived fields, exactly
        // like content_signature/embedding. See nullIfContentChanged above.
        yoeMin: nullIfContentChanged(jobs.yoeMin),
        yoeMax: nullIfContentChanged(jobs.yoeMax),
        salaryMin: nullIfContentChanged(jobs.salaryMin),
        salaryMax: nullIfContentChanged(jobs.salaryMax),
        salaryCurrency: nullIfContentChanged(jobs.salaryCurrency),
        salaryPeriod: nullIfContentChanged(jobs.salaryPeriod),
        enrichedAt: nullIfContentChanged(jobs.enrichedAt),
        updatedAt: sql`now()`,
      },
      // Advance the row only when a real change differs. Two fields are written
      // above but deliberately EXCLUDED from this test:
      //  - `raw`: Greenhouse bumps an internal timestamp inside it on nearly
      //    every fetch, so comparing it would defeat idempotency.
      //  - `posted_at`: the adapter derives it as `first_published || updated_at`,
      //    so for postings lacking `first_published` it ALIASES that same churning
      //    `updated_at`; comparing it would reintroduce exactly the instability
      //    `raw` is excluded to avoid. Still written, so it stays fresh whenever a
      //    real change fires.
      //  - `content_signature` (Phase F1): rewritten unconditionally in the set block
      //    above but DELIBERATELY excluded from this test. It is a PURE function of
      //    title + description_text — the exact two fields this test already checks (and
      //    the embedding CASE keys on) — so it changes IFF those clauses already fire;
      //    rewriting it when only a non-content field changed is a harmless no-op
      //    (identical md5), and an unchanged re-ingest never runs the set at all. Do NOT
      //    add it to this test (redundant), and do NOT drop the title/description clauses
      //    thinking the signature subsumes them (that would silently defeat idempotency +
      //    re-embedding). See repos/sql.ts signatureSql + PHASE_F1_PLAN.md §4.2.
      //  - `yoe_*` / `salary_*` / `enriched_at` (Phase F4): reset by nullIfContentChanged in the
      //    set block above on the SAME title/description trigger, and likewise EXCLUDED from this test — they
      //    are derived from those two fields, so the rule is identical to content_signature (written here,
      //    not tested here). The async extraction writer (repos/enrichment.ts) is what re-populates them.
      // OTHER-PHASE WRITERS, note:
      //  - `lifecycle_state` is NOT written here (this set leaves it at its existing
      //    value). Phase F2's closing/revival is a SEPARATE writer (repos/lifecycle.ts
      //    sweepLifecycle) precisely because reviving a reappearing job to 'active' must
      //    NOT be gated by this content test — an unchanged-but-reappearing job would
      //    otherwise stay 'closed'. Keep lifecycle_state out of this set block.
      //  - `locations` is compared as an ORDER-SENSITIVE jsonb array, but the
      //    values above are sorted to a canonical order on write, so a
      //    multi-location adapter that reorders offices won't report a spurious
      //    change. (Keep that sort if this comparison stays order-sensitive.)
      setWhere: sql`
        ${jobs.companyId} IS DISTINCT FROM excluded.company_id OR
        ${jobs.title} IS DISTINCT FROM excluded.title OR
        ${jobs.descriptionText} IS DISTINCT FROM excluded.description_text OR
        ${jobs.locations} IS DISTINCT FROM excluded.locations OR
        ${jobs.remote} IS DISTINCT FROM excluded.remote OR
        ${jobs.applyUrl} IS DISTINCT FROM excluded.apply_url
      `,
    })
    .returning({ id: jobs.id });

  return { changed: updated.length, total: deduped.size };
}
