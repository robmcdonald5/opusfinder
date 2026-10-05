/**
 * Persistence for companies + jobs. Functional style: the Drizzle client is
 * injected (no module-level singleton), matching `createDb()` in ../client.
 *
 * Both upserts are idempotent. `upsertCompany` is get-or-create; `upsertJobs`
 * dedupes the batch, never writes a failed hydrate's placeholder content (nor a posting
 * the ATS says is gone), then only advances `updated_at` when a job actually changed, so
 * re-ingesting an unchanged board is a no-op.
 */
import { and, type AnyColumn, eq, gt, sql, type SQL } from "drizzle-orm";

import type { CompanySlug, NormalizedJob, SourceName } from "@opusfinder/shared";

import type { Db } from "../client";
import { companies, jobs } from "../schema";
import { NUL, signatureSql } from "./sql";

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
 * a cron sets `activeOnly: true` to skip boards discovery has deactivated; it defaults falsey
 * so existing callers are unchanged. `afterId` + `limit` form an id-keyset cursor
 * (`WHERE id > afterId ORDER BY id LIMIT limit`) for the chunked-cron lane — the chunk is built
 * in SQL, not by loading the whole table and slicing in memory.
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
 * Max rows per INSERT batch in {@link upsertJobs}. Sized to stay well under Postgres's 65,535
 * bound-parameter ceiling (~12 binds/row ⇒ a hard ceiling of ~5,461 rows) AND to keep each neon-http
 * request payload small, so a mega-board (SmartRecruiters boschgroup ~4.6k postings) can't emit one
 * oversized statement that fails on payload size and helps blow the Worker's per-invocation budget.
 * Most boards are a single batch; only pathologically large boards split.
 */
const UPSERT_BATCH_SIZE = 500;

/** What {@link upsertJobs} did with a board's postings (all counts are DISTINCT postings). */
export interface UpsertJobsResult {
  /** Rows inserted or updated (an unchanged re-ingest is skipped by `setWhere` and not counted). */
  changed: number;
  /** Postings WRITTEN with their content (`unchanged = total - changed`). */
  total: number;
  /** `contentMissing` postings: content NOT written (a stored row's list fields may be refreshed). */
  contentMissing: number;
  /** `gone` postings: not written at all (the caller also leaves them out of presence). */
  gone: number;
}

/**
 * Batch-upsert a board's jobs via INSERT ... ON CONFLICT, split into {@link UPSERT_BATCH_SIZE}-row
 * batches (one neon-http round-trip each). Conflict key is `(source, external_id)`. Returns an
 * {@link UpsertJobsResult}; the caller reports `collapsed = input.length - total - contentMissing - gone`.
 *
 * CONTENT GUARD — enforced HERE, the single persistence choke point, so EVERY caller is protected
 * rather than each filtering for itself:
 *  - A `NormalizedJob.contentMissing` job (a TRANSIENT hydrate failure: its title/description are
 *    list-level placeholders) never writes CONTENT. A stored row keeps its title, description,
 *    content_signature and embedding; writing the placeholder would overwrite the description, NULL the
 *    embedding (a paid re-embed) and recompute the signature from the title alone (an F1 de-dupe
 *    collapse), then flip it all back on the next good hydrate. Its LIST-sourced fields are still
 *    refreshed on the stored row ({@link refreshListFields}) — company_id above all: a posting that moved
 *    boards must land on the board that lists it now, or markJobsPresent (company-scoped) misses it and
 *    the OLD board's absence sweep closes a live job. A posting not yet stored is not inserted until a
 *    run fetches its content.
 *  - A `NormalizedJob.gone` job (the ATS said it no longer exists) is not written at all.
 * Presence is NOT this writer's job: the caller stamps every listed, non-gone posting present
 * (markJobsPresent / sweepLifecycle), so a transient detail failure never ages or sweeps a live job.
 */
export async function upsertJobs(
  db: Db,
  companyId: number,
  list: NormalizedJob[],
): Promise<UpsertJobsResult> {
  // Collapse duplicate (source, external_id) BEFORE the batch: a single
  // INSERT ... ON CONFLICT cannot affect the same conflict key twice (Postgres
  // raises 21000), and a board can repeat a posting id (cross-listed roles) or a
  // future source may reuse ids. Last occurrence wins — EXCEPT that the more complete copy
  // always wins, in either order: content > contentMissing > gone (see `completeness`). So a
  // duplicated posting whose other copy hydrated is written from it and counted once, never as
  // missing or gone. Richer merging of duplicates (e.g. multi-location postings) is an adapter
  // concern, not here.
  const deduped = new Map<string, NormalizedJob>();
  for (const job of list) {
    const key = JSON.stringify([job.source, job.externalId]);
    const kept = deduped.get(key);
    if (kept && completeness(job) < completeness(kept)) continue;
    deduped.set(key, job);
  }
  // The content guard (see the doc above), applied AFTER the dedupe so each posting is counted once.
  const distinct = [...deduped.values()];
  const writable = distinct.filter((job) => completeness(job) === COMPLETE);
  const missing = distinct.filter((job) => completeness(job) === CONTENT_MISSING);
  const gone = distinct.length - writable.length - missing.length;
  if (missing.length > 0) await refreshListFields(db, companyId, missing);
  // Guard the empty case: `INSERT ... VALUES` with no rows is invalid SQL.
  if (writable.length === 0) return { changed: 0, total: 0, contentMissing: missing.length, gone };

  const values = writable.map((job) => {
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
      // Order isn't semantically meaningful for ATS locations.
      locations: [...job.locations].map((loc) => loc.replaceAll(NUL, "")).sort(),
      remote: job.remote,
      applyUrl: job.applyUrl.replaceAll(NUL, ""),
      postedAt: job.postedAt,
      // The `raw` column is DEPRECATED and intentionally NOT written — write-only debug data that grew to
      // dominate the DB (NormalizedJob no longer even carries it). The column is nullable; omitting it from
      // the INSERT leaves it NULL. See schema.ts jobs doc.
      // content_signature: md5 over the SAME normalized title+desc, computed SQL-side from the
      // bound (NUL-stripped) values via the ONE signatureSql definition — byte-identical to the ON CONFLICT
      // SET and the backfill, so an insert and any later re-ingest/backfill of the same content always
      // produce the same signature. (embedding omitted — populated by the embedding backfill.)
      contentSignature: signatureSql(sql`${title}`, sql`${descriptionText}`),
    };
  });

  // The content-derived `embedding` resets to NULL when (and only when) title/description_text change, so
  // the backfill re-embeds next pass; any other (setWhere) churn KEEPS the existing vector (re-embedding
  // identical prose is wasted work + tokens). The helper reads ${jobs.embedding} (the EXISTING row), NEVER
  // excluded.embedding: the INSERT VALUES omits the derived column, so excluded.* is the column DEFAULT
  // (NULL) and an `ELSE excluded.embedding` would silently NULL every already-embedded row on every
  // non-content churn. (content_signature is the exception — it is RECOMPUTED, not preserved, so it stays an
  // unconditional rewrite rather than this preserve-or-null CASE.)
  const nullIfContentChanged = (col: AnyColumn): SQL => sql`CASE
          WHEN ${jobs.title} IS DISTINCT FROM excluded.title
            OR ${jobs.descriptionText} IS DISTINCT FROM excluded.description_text
          THEN NULL
          ELSE ${col}
        END`;

  // The ON CONFLICT config is batch-agnostic (every clause references excluded.* / jobs.*, never the
  // batch rows), so build it ONCE and reuse it for each batch below.
  const conflictUpdate = {
    target: [jobs.source, jobs.externalId],
    // Write every comparable field + company_id, refresh the write-only `posted_at`, conditionally reset
    // the derived embedding, and advance updated_at. INVARIANT: every column tested in `setWhere` below
    // must also appear here — a field compared but not written would make every re-ingest look "changed".
    set: {
      companyId: sql`excluded.company_id`,
      title: sql`excluded.title`,
      descriptionText: sql`excluded.description_text`,
      locations: sql`excluded.locations`,
      remote: sql`excluded.remote`,
      applyUrl: sql`excluded.apply_url`,
      postedAt: sql`excluded.posted_at`,
      // Reset the derived embedding on a content change, keep it otherwise (see nullIfContentChanged above).
      embedding: nullIfContentChanged(jobs.embedding),
      // content_signature: rewritten unconditionally from excluded title+desc via the ONE signatureSql
      // definition (the setWhere note below explains why it is written but NOT also tested).
      contentSignature: signatureSql(sql`excluded.title`, sql`excluded.description_text`),
      updatedAt: sql`now()`,
    },
    // Advance the row only when a real change differs. Fields written above but deliberately EXCLUDED
    // from this test:
    //  - `posted_at`: the adapter derives it as `first_published || updated_at`, so for postings lacking
    //    `first_published` it ALIASES that same churning `updated_at`; comparing it would make nearly every
    //    re-fetch look "changed" and defeat idempotency. Still written, so it stays fresh on a real change.
    //  - `content_signature`: a PURE function of title + description_text — the exact two fields this test
    //    already checks — so it changes IFF those clauses already fire; rewriting it on a non-content change
    //    is a harmless no-op (identical md5). Do NOT add it to this test (redundant), and do NOT drop the
    //    title/description clauses thinking the signature subsumes them (that would defeat idempotency +
    //    re-embedding).
    //  - `lifecycle_state` is NOT written here (left at its existing value). The closing/revival is a
    //    SEPARATE writer (repos/lifecycle.ts sweepLifecycle) precisely because reviving a reappearing job to
    //    'active' must NOT be gated by this content test — an unchanged-but-reappearing job would otherwise
    //    stay 'closed'. Keep lifecycle_state out of this set block.
    setWhere: sql`
        ${jobs.companyId} IS DISTINCT FROM excluded.company_id OR
        ${jobs.title} IS DISTINCT FROM excluded.title OR
        ${jobs.descriptionText} IS DISTINCT FROM excluded.description_text OR
        ${jobs.locations} IS DISTINCT FROM excluded.locations OR
        ${jobs.remote} IS DISTINCT FROM excluded.remote OR
        ${jobs.applyUrl} IS DISTINCT FROM excluded.apply_url
      `,
  };

  // Run the upsert in payload-bounded batches (see UPSERT_BATCH_SIZE). The whole-board dedupe ABOVE
  // already ran, so a conflict key can't straddle two batches and re-raise Postgres 21000. Each batch is
  // a separate neon-http autocommit statement (no wrapping txn — a per-board failure is already isolated
  // in runIngestion and the upsert is idempotent, so a mid-board failure self-heals on the next ingest).
  // `changed` sums across batches; `total` stays the whole-board distinct count.
  let changed = 0;
  for (let offset = 0; offset < values.length; offset += UPSERT_BATCH_SIZE) {
    const updated = await db
      .insert(jobs)
      .values(values.slice(offset, offset + UPSERT_BATCH_SIZE))
      .onConflictDoUpdate(conflictUpdate)
      .returning({ id: jobs.id });
    changed += updated.length;
  }

  return { changed, total: writable.length, contentMissing: missing.length, gone };
}

const GONE = 0;
const CONTENT_MISSING = 1;
const COMPLETE = 2;
/** How complete a copy is — the dedupe keeps the higher one: content > contentMissing > gone. */
function completeness(job: NormalizedJob): number {
  return job.gone ? GONE : job.contentMissing ? CONTENT_MISSING : COMPLETE;
}

/**
 * For STORED rows of `contentMissing` postings, write the LIST-sourced fields the board just fetched —
 * company_id (the board listing it now), locations, remote and posted_at — and NEVER a content column
 * (title / description_text / content_signature / embedding). One UPDATE, issued only when a board has
 * such postings; a posting with no stored row matches nothing (it is not inserted without content).
 * Gated like upsertJobs' setWhere: a row is rewritten (and updated_at advanced) only when company_id,
 * locations or remote differ, so a repeat failure on an unchanged posting writes nothing; posted_at is
 * written with them but not compared (the same churn reason as the upsert).
 *
 * apply_url is deliberately NOT refreshed: on the only hydrating source (SmartRecruiters) the un-hydrated
 * apply URL is mapItem's RECONSTRUCTED placeholder, not a list field — writing it would swap the stored
 * real link for the placeholder on every failed hydrate and back on the next good one (the same churn
 * class this guard exists to stop). The set rides as ONE jsonb param (NUL stripped — jsonb rejects it).
 */
async function refreshListFields(
  db: Db,
  companyId: number,
  list: NormalizedJob[],
): Promise<void> {
  const rows = JSON.stringify(
    list.map((job) => ({
      source: job.source,
      external_id: job.externalId.replaceAll(NUL, ""),
      locations: [...job.locations].map((loc) => loc.replaceAll(NUL, "")).sort(),
      remote: job.remote,
      posted_at: job.postedAt?.toISOString() ?? null,
    })),
  );
  await db.execute(sql`
    UPDATE ${jobs} SET
      company_id = ${companyId},
      locations = v.locations,
      remote = v.remote,
      posted_at = v.posted_at,
      updated_at = now()
    FROM jsonb_to_recordset(${rows}::jsonb)
      AS v(source text, external_id text, locations jsonb, remote boolean, posted_at timestamptz)
    WHERE jobs.source = v.source AND jobs.external_id = v.external_id
      AND (
        jobs.company_id IS DISTINCT FROM ${companyId}
        OR jobs.locations IS DISTINCT FROM v.locations
        OR jobs.remote IS DISTINCT FROM v.remote
      )
  `);
}
