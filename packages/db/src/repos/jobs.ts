/**
 * Persistence for companies + jobs. Functional style: the Drizzle client is
 * injected (no module-level singleton), matching `createDb()` in ../client.
 *
 * Both upserts are idempotent. `upsertCompany` is get-or-create; `upsertJobs`
 * dedupes the batch, never writes a failed hydrate's placeholder content (its stored row only
 * follows the board listing it), then only advances `updated_at` when a job actually changed, so
 * re-ingesting an unchanged board is a no-op.
 */
import { and, type AnyColumn, eq, gt, inArray, ne, or, sql, type SQL } from "drizzle-orm";

import {
  isRecord,
  type CompanySlug,
  type JobId,
  type NormalizedJob,
  type SourceName,
} from "@opusfinder/shared";

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

/** One row per board for sources whose API ignores slug case (schema.ts; migration 0025). */
const CASE_VARIANT_UQ = "companies_source_lower_slug_uq";

/**
 * Get-or-create the company for `(slug, source)` and return its id.
 *
 * The no-op `set` (slug ← its own excluded value) makes the conflicting row
 * "affected" so `RETURNING` yields the id even when the company already exists —
 * a bare `onConflictDoNothing` returns no rows on conflict. It writes nothing
 * meaningful, so `companies.updated_at` is left untouched.
 *
 * A case variant of a stored slug on a case-insensitive source (`boschgroup` beside `BoschGroup`) is NOT
 * get-or-create: `companies_source_lower_slug_uq` rejects it and this throws a plain message naming the
 * slug, since the CLI prints only `err.message` and drizzle's own reads "Failed query: …" with no reason.
 */
export async function upsertCompany(
  db: Db,
  slug: CompanySlug,
  source: SourceName,
): Promise<number> {
  let rows: { id: number }[];
  try {
    rows = await db
      .insert(companies)
      .values({ slug, source })
      .onConflictDoUpdate({
        target: [companies.slug, companies.source],
        set: { slug: sql`excluded.slug` },
      })
      .returning({ id: companies.id });
  } catch (err) {
    // The driver error rides drizzle's `cause` (Neon's and PGlite's both carry `constraint`).
    if (err instanceof Error && isRecord(err.cause) && err.cause.constraint === CASE_VARIANT_UQ) {
      throw new Error(
        `${source}:"${slug}" is a case variant of an existing ${source} company (${source} board ids ` +
          `ignore case; ${CASE_VARIANT_UQ}). That board is already tracked: use its stored slug.`,
        { cause: err },
      );
    }
    throw err;
  }

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

/** Postgres regex for a BLANK description (empty or whitespace only) — the empty-description guard's one
 *  definition, used SQL-side so it matches exactly what Postgres stores. POSIX `[[:space:]]` (no
 *  backslash: inside a `sql` template a `\s` would cook to a bare `s` — see signatureSql). */
const BLANK_RE = sql.raw(`'^[[:space:]]*$'`);

/** What {@link upsertJobs} did with a board's postings (all counts are DISTINCT postings). */
export interface UpsertJobsResult {
  /** Rows inserted or updated (an unchanged re-ingest is skipped by `setWhere` and not counted). */
  changed: number;
  /** Postings WRITTEN with their content (`unchanged = total - changed`). */
  total: number;
  /** `contentMissing` postings: content NOT written (a stored row only has its company_id refreshed). */
  contentMissing: number;
}

/**
 * Batch-upsert a board's jobs via INSERT ... ON CONFLICT, split into {@link UPSERT_BATCH_SIZE}-row
 * batches (one neon-http round-trip each). Conflict key is `(source, external_id)`. Returns an
 * {@link UpsertJobsResult}; the caller reports `collapsed = input.length - total - contentMissing`.
 *
 * CONTENT GUARD — enforced HERE, the single persistence choke point, so EVERY caller is protected
 * rather than each filtering for itself:
 *  - A `NormalizedJob.contentMissing` job (a failed or empty hydrate: its title/description are list-level
 *    placeholders) never writes CONTENT. A stored row keeps its title, description, content_signature and
 *    embedding; writing the placeholder would overwrite the description, NULL the embedding (a paid
 *    re-embed) and recompute the signature from the title alone (an F1 de-dupe collapse), then flip it all
 *    back on the next good hydrate. Only its company_id is refreshed ({@link moveToListingBoard}), so a
 *    posting that moved boards isn't falsely closed by its old board's sweep. A posting not yet stored is
 *    not inserted until a run fetches its content.
 *  - ANY job (every source): a BLANK incoming description never replaces a non-blank stored one — the
 *    stored text, its content_signature and its embedding are kept (see `description` in the body). A
 *    new posting is inserted as given, "" included.
 * Presence is NOT this writer's job: the caller stamps every LISTED posting present (markJobsPresent /
 * sweepLifecycle), so a failed detail fetch never ages or sweeps a live job.
 */
export async function upsertJobs(
  db: Db,
  companyId: number,
  list: NormalizedJob[],
): Promise<UpsertJobsResult> {
  // Collapse duplicate (source, external_id) BEFORE the batch: a single
  // INSERT ... ON CONFLICT cannot affect the same conflict key twice (Postgres
  // raises 21000), and a board can repeat a posting id (cross-listed roles) or a
  // future source may reuse ids. Last occurrence wins — EXCEPT that a copy WITH content
  // always beats a contentMissing copy, in either order, so a duplicated posting whose
  // other copy hydrated is written from it (and not counted missing). Richer merging of
  // duplicates (e.g. multi-location postings) is an adapter concern, not here.
  const deduped = new Map<string, NormalizedJob>();
  for (const job of list) {
    const key = JSON.stringify([job.source, job.externalId]);
    const kept = deduped.get(key);
    if (job.contentMissing && kept && !kept.contentMissing) continue;
    deduped.set(key, job);
  }
  // The content guard (see the doc above), applied AFTER the dedupe so each posting is counted once.
  const distinct = [...deduped.values()];
  const writable = distinct.filter((job) => !job.contentMissing);
  const missing = distinct.filter((job) => job.contentMissing);
  if (missing.length > 0) await moveToListingBoard(db, companyId, missing);
  // Guard the empty case: `INSERT ... VALUES` with no rows is invalid SQL.
  if (writable.length === 0) return { changed: 0, total: 0, contentMissing: missing.length };

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

  // EMPTY-DESCRIPTION GUARD (any source): a blank (empty/whitespace) incoming description never replaces a
  // NON-blank stored one — the stored text is kept, so content_signature and the embedding don't move for
  // it either. A blank body over real text is a fetch anomaly, not an edit: an inline-content source (e.g.
  // Greenhouse `content=true`, Workable `details=true`, Lever) momentarily serving "", or SmartRecruiters'
  // `jobAd.sections: {}`. Writing it would NULL the embedding (a paid re-embed) and collapse the signature
  // to the title alone (F1 de-dupe), then flip back. Every description reference below goes through this
  // ONE expression (the SET, the signature, the embedding reset, setWhere) so they can't disagree. A title
  // change in the same row still applies normally. A posting with NO stored row is inserted as given, ""
  // included (its first fetch is all we have; some postings genuinely have no body).
  const description = sql`CASE
          WHEN excluded.description_text ~ ${BLANK_RE} AND ${jobs.descriptionText} !~ ${BLANK_RE}
          THEN ${jobs.descriptionText}
          ELSE excluded.description_text
        END`;

  // The content-derived `embedding` resets to NULL when (and only when) title/description_text change, so
  // the backfill re-embeds next pass; any other (setWhere) churn KEEPS the existing vector (re-embedding
  // identical prose is wasted work + tokens). The helper reads ${jobs.embedding} (the EXISTING row), NEVER
  // excluded.embedding: the INSERT VALUES omits the derived column, so excluded.* is the column DEFAULT
  // (NULL) and an `ELSE excluded.embedding` would silently NULL every already-embedded row on every
  // non-content churn. (content_signature is the exception — it is RECOMPUTED, not preserved, so it stays an
  // unconditional rewrite rather than this preserve-or-null CASE.)
  const nullIfContentChanged = (col: AnyColumn): SQL => sql`CASE
          WHEN ${jobs.title} IS DISTINCT FROM excluded.title
            OR ${jobs.descriptionText} IS DISTINCT FROM (${description})
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
      // The empty-description guard (see `description` above): the stored text survives a blank re-fetch.
      descriptionText: description,
      locations: sql`excluded.locations`,
      remote: sql`excluded.remote`,
      applyUrl: sql`excluded.apply_url`,
      postedAt: sql`excluded.posted_at`,
      // Reset the derived embedding on a content change, keep it otherwise (see nullIfContentChanged above).
      embedding: nullIfContentChanged(jobs.embedding),
      // content_signature: rewritten unconditionally from excluded title+desc via the ONE signatureSql
      // definition (the setWhere note below explains why it is written but NOT also tested).
      contentSignature: signatureSql(sql`excluded.title`, sql`(${description})`),
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
        ${jobs.descriptionText} IS DISTINCT FROM (${description}) OR
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

  return { changed, total: writable.length, contentMissing: missing.length };
}

/**
 * Point the STORED rows of `contentMissing` postings at `companyId` — the board listing them now — and
 * write nothing else (never a content column). A posting that moved boards while its detail fetch fails
 * would otherwise keep its OLD company_id: markJobsPresent (company-scoped) would miss it on the new board
 * and the old board's absence sweep would close a live job. One UPDATE, scoped to exactly the listed
 * (source, external_id) pairs, and only rows that actually moved are rewritten; a posting with no stored
 * row matches nothing. An EMPTY list returns at once: with no pairs the OR would vanish and the UPDATE
 * would move every row of every other board onto this one. (Exported for its own scope tests.)
 */
export async function moveToListingBoard(
  db: Db,
  companyId: number,
  list: NormalizedJob[],
): Promise<void> {
  if (list.length === 0) return;
  const idsBySource = new Map<SourceName, JobId[]>();
  for (const job of list) {
    // NUL-stripped like the lifecycle writers' present sets: Postgres text rejects U+0000, and one bad id
    // would fail the whole statement (and with it the board).
    const id = stripNul(job.externalId) as JobId;
    const ids = idsBySource.get(job.source);
    if (ids) ids.push(id);
    else idsBySource.set(job.source, [id]);
  }
  const listed = [...idsBySource].map(([source, ids]) =>
    and(eq(jobs.source, source), inArray(jobs.externalId, ids)),
  );
  await db
    .update(jobs)
    .set({ companyId, updatedAt: sql`now()` })
    .where(and(ne(jobs.companyId, companyId), or(...listed)));
}
