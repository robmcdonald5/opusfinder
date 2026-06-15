/**
 * Job-enrichment persistence (Phase F4). Read the rows still missing enrichment, write a batch of
 * extracted {@link JobEnrichment} back (stamping the `enriched_at` SENTINEL), and drive the
 * extract → write loop.
 *
 * Mirrors the embedding lifecycle (repos/embeddings.ts) with two deliberate divergences, both forced by
 * the fact that extraction — unlike embedding — CAN throw (the model returns invalid/out-of-bounds JSON):
 *   1. The needs-work key is the `enriched_at` SENTINEL, not a data column. A successful extraction can
 *      legitimately leave every data column NULL ("found nothing in the prose"), so "all data NULL" cannot
 *      distinguish not-yet-done from done-found-nothing — only the marker can. The write stamps enriched_at
 *      even for an all-NULL row, so those rows stop matching.
 *   2. The loop uses a KEYSET cursor on `id` (the embedding loop is cursorless). A row whose extraction
 *      THROWS is left un-stamped (retried on the NEXT run, per the plan), but a cursorless `WHERE
 *      enriched_at IS NULL` re-query would re-select that same row forever WITHIN one run. The keyset
 *      (`id > afterId`) advances past it, so a persistently-failing row can't wedge the loop.
 *
 * The extractor is an INJECTED function ({@link ExtractFn}) rather than an import of `@opusfinder/llm`, so
 * this package keeps zero dependency on the LLM stack (and on `@anthropic-ai/sdk`, which `guard:worker`
 * forbids) — the same dependency-injection style as `backfillJobEmbeddings` taking an `EmbedFn`.
 */
import type { JobEnrichment } from "@opusfinder/shared";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import type { Db } from "../client";
import { jobs } from "../schema";
import { NUL, resultRows } from "./sql";

// Cap rows per UPDATE so a large caller can't exceed Postgres's 65535 bind-param ceiling. Each row binds
// id + 6 data columns = 7 typed params (enriched_at is a constant `now()`, not a per-row bind), so the
// ceiling is 65535/7 ≈ 9362; this stays comfortably under. The backfill's default batch is far smaller, so
// this never splits in practice — it guards future bulk callers of the exported primitive.
const MAX_ROWS_PER_WRITE = 7000;

/**
 * The extractor shape this module needs: turn a job's text into a {@link JobEnrichment}. The real
 * extractor (the @opusfinder/llm pure core wired to `generateObject`) is structurally assignable, so the
 * Node-side caller passes it directly. Injected (never imported) so `db` stays LLM/SDK-free.
 */
export type ExtractFn = (job: { title: string; descriptionText: string }) => Promise<JobEnrichment>;

export interface JobNeedingEnrichment {
  id: number;
  title: string;
  descriptionText: string;
}

/**
 * The next batch of jobs whose `enriched_at` is still NULL (not yet extracted), id-ordered and keyset-paged
 * past `afterId`. Optionally scoped to one company. The non-whitespace content guard is a COST guard (don't
 * spend a model call on a fully-empty row) + a backstop; it mirrors `jobsNeedingEmbedding` so the two notions
 * of "has extractable content" stay aligned (`description_text` is `''` not NULL, so a title-only job still
 * qualifies). Termination is guaranteed by the keyset, NOT by this guard (see the module note): a row whose
 * extraction throws stays `enriched_at IS NULL` but has `id <= afterId`, so it is not re-selected this run.
 */
export async function jobsNeedingEnrichment(
  db: Db,
  opts: { companyId?: number; afterId?: number; limit: number },
): Promise<JobNeedingEnrichment[]> {
  const conditions = [
    isNull(jobs.enrichedAt),
    sql`(${jobs.title} ~ '[^[:space:]]' OR ${jobs.descriptionText} ~ '[^[:space:]]')`,
  ];
  if (opts.companyId !== undefined) conditions.push(eq(jobs.companyId, opts.companyId));
  if (opts.afterId !== undefined && opts.afterId > 0) conditions.push(gt(jobs.id, opts.afterId));

  return db
    .select({ id: jobs.id, title: jobs.title, descriptionText: jobs.descriptionText })
    .from(jobs)
    .where(and(...conditions))
    .orderBy(jobs.id)
    .limit(opts.limit);
}

/**
 * Write a batch of extractions back, one `UPDATE ... FROM (VALUES ...)` per chunk (one neon-http round-trip
 * per chunk). `enriched_at = now()` is set unconditionally for every written row — INCLUDING an all-NULL
 * "found nothing" row — so the SENTINEL, not the data, marks the row done. `updated_at` is NOT touched (it
 * tracks CONTENT changes; enrichment is derived). Every value carries an explicit `::type` cast: a bare NULL
 * in a VALUES tuple is `unknown` to Postgres and the `SET salary_min = v.salary_min` integer assignment would
 * fail to infer a type (the writeJobEmbeddings precedent). `salary_currency` is the one free-text column, so
 * it is NUL-stripped (Postgres rejects U+0000 in text) — the other text column, `salary_period`, comes from a
 * closed enum and needs no strip. An empty `rows` writes nothing. Returns the number of rows updated.
 */
export async function writeJobEnrichment(
  db: Db,
  rows: { id: number; enrichment: JobEnrichment }[],
): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_WRITE) {
    const chunk = rows.slice(i, i + MAX_ROWS_PER_WRITE);
    const tuples = chunk.map((r) => {
      const e = r.enrichment;
      const currency = e.salaryCurrency === null ? null : e.salaryCurrency.replaceAll(NUL, "");
      return sql`(${r.id}::int, ${e.yoeMin}::smallint, ${e.yoeMax}::smallint, ${e.salaryMin}::int, ${e.salaryMax}::int, ${currency}::text, ${e.salaryPeriod}::text)`;
    });
    const result: unknown = await db.execute(sql`
      UPDATE ${jobs} AS j
      SET yoe_min = v.yoe_min,
          yoe_max = v.yoe_max,
          salary_min = v.salary_min,
          salary_max = v.salary_max,
          salary_currency = v.salary_currency,
          salary_period = v.salary_period,
          enriched_at = now()
      FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(id, yoe_min, yoe_max, salary_min, salary_max, salary_currency, salary_period)
      WHERE j.id = v.id
      RETURNING j.id
    `);
    // RETURNING gives one row per update; trust it, fall back to chunk size if the driver shape is
    // unrecognized (a statement that didn't throw). Same posture as writeJobEmbeddings.
    const returned = resultRows(result).length;
    written += returned > 0 ? returned : chunk.length;
  }
  return written;
}

/** The fetch/write seams the drain loop drives — injected so the loop is unit-testable without a DB. */
export interface EnrichmentDeps {
  fetch: (afterId: number, limit: number) => Promise<JobNeedingEnrichment[]>;
  write: (rows: { id: number; enrichment: JobEnrichment }[]) => Promise<number>;
}

/**
 * The pure extract → write loop, factored out of {@link backfillJobEnrichment} so the lifecycle smoke can
 * exercise it with stubbed seams (no creds, no Postgres). Each fetched batch is extracted with bounded
 * concurrency (= `batchSize`: the fetched rows run together), then the successes are written in one
 * statement. A row whose extraction THROWS is counted, logged shape-only, and SKIPPED (left un-stamped for
 * the next run); the keyset (`afterId`) guarantees it is not re-fetched within this run. Returns
 * `{ enriched, failed }`.
 */
export async function drainEnrichment(
  extract: ExtractFn,
  deps: EnrichmentDeps,
  opts: { batchSize?: number } = {},
): Promise<{ enriched: number; failed: number }> {
  const batchSize = opts.batchSize ?? 8;
  let afterId = 0;
  let enriched = 0;
  let failed = 0;

  for (;;) {
    const batch = await deps.fetch(afterId, batchSize);
    if (batch.length === 0) break;
    // Rows are id-ordered; advance the keyset past the whole batch so a throwing (un-stamped) row in it is
    // not re-selected this run — the loop makes forward progress regardless of per-row failures.
    afterId = batch[batch.length - 1]!.id;

    const settled = await Promise.all(
      batch.map(async (job) => {
        try {
          return { id: job.id, enrichment: await extract(job) };
        } catch (err) {
          failed++;
          // Shape-only: id + error class, NEVER the message (it can echo job prose). Left un-stamped so the
          // next RUN retries it; the keyset prevents an in-run re-select.
          console.warn(`enrich: job ${job.id} extraction failed (${(err as Error)?.name ?? "Error"})`);
          return null;
        }
      }),
    );

    const toWrite = settled.filter(
      (r): r is { id: number; enrichment: JobEnrichment } => r !== null,
    );
    if (toWrite.length > 0) enriched += await deps.write(toWrite);
  }

  return { enriched, failed };
}

/**
 * Enrich every job whose `enriched_at` is still NULL, in keyset-paged batches: fetch → extract → write+stamp.
 * Idempotent and re-runnable — a row whose extraction throws is left un-stamped and retried on the next run.
 * `extract` is injected (see {@link ExtractFn}). Returns the count enriched + the count that failed extraction
 * so the caller can report both.
 */
export function backfillJobEnrichment(
  db: Db,
  extract: ExtractFn,
  opts: { companyId?: number; batchSize?: number } = {},
): Promise<{ enriched: number; failed: number }> {
  return drainEnrichment(
    extract,
    {
      fetch: (afterId, limit) =>
        jobsNeedingEnrichment(db, { companyId: opts.companyId, afterId, limit }),
      write: (rows) => writeJobEnrichment(db, rows),
    },
    opts,
  );
}
