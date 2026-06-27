/**
 * Job-embedding persistence. Read the rows still missing a vector, write a
 * batch of vectors back, drive the embed → write loop, and run cosine nearest-neighbour
 * retrieval.
 *
 * The orchestrator takes the embedder as an INJECTED function (`EmbedFn`) rather than
 * importing `@opusfinder/embeddings`, so this package keeps zero dependency on the
 * embeddings package (the dependency points the other way: embeddings/sources scripts
 * import these repos). Same dependency-injection style as `createDb` taking its client.
 */
import { composeEmbeddingText } from "@opusfinder/shared";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";

import type { Db } from "../client";
import { jobs } from "../schema";
import { resultRows, VECTOR_CAST, vectorLiteral } from "./sql";

// Cap rows per UPDATE so a large caller can't exceed Postgres's 65535 bind-param ceiling
// (2 params/row). The default backfill batch (64) is far under; this guards future bulk
// callers of writeJobEmbeddings.
const MAX_ROWS_PER_WRITE = 1000;

/** Voyage retrieval hint, redeclared structurally so `db` need not import embeddings. */
type EmbedInputType = "query" | "document" | null;

/**
 * The embedder shape this module needs. The real `embed` from `@opusfinder/embeddings`
 * is structurally assignable (its extra `model` return field and optional params are
 * compatible), so callers pass it directly.
 */
type EmbedFn = (
  texts: string[],
  params: { inputType: EmbedInputType },
) => Promise<{ embeddings: number[][]; usage: { totalTokens: number } }>;

export interface JobNeedingEmbedding {
  id: number;
  title: string;
  descriptionText: string;
}

/**
 * The next batch of jobs whose `embedding` is still NULL, oldest id first. Optionally
 * scoped to one company (the ingestion path embeds just the board it touched). `limit`
 * bounds the batch so a huge backlog is processed in chunks.
 */
/**
 * The "has embeddable (non-whitespace) content" predicate: title OR description_text contains a
 * non-whitespace char. The SINGLE SOURCE shared by jobsNeedingEmbedding and the parity smoke, so the
 * two cannot drift. It MUST stay aligned with composeEmbeddingText's empty-notion
 * (`parts.filter((s) => s.trim().length > 0)`, see jobEmbeddingText) — that alignment is what lets the
 * embed-backlog drain terminate without a cursor (a row this predicate excludes also produces empty
 * embed text, so it is never selected AND would never reach embed(), which Voyage 400s on ""). The POSIX
 * class `[^[:space:]]` matches JS .trim() for ASCII whitespace, diverging only on exotic Unicode
 * whitespace (e.g. NBSP) — negligible for ATS data. If jobEmbeddingText starts composing more than
 * title + description, update this predicate in lockstep.
 */
export const embeddableContentSql: SQL = sql`(${jobs.title} ~ '[^[:space:]]' OR ${jobs.descriptionText} ~ '[^[:space:]]')`;

export async function jobsNeedingEmbedding(
  db: Db,
  opts: { companyId?: number; limit: number },
): Promise<JobNeedingEmbedding[]> {
  // Rows with no vector AND embeddable content (the empty-content check lives in SQL).
  const conditions = [isNull(jobs.embedding), embeddableContentSql];
  if (opts.companyId !== undefined) conditions.push(eq(jobs.companyId, opts.companyId));

  return db
    .select({ id: jobs.id, title: jobs.title, descriptionText: jobs.descriptionText })
    .from(jobs)
    .where(and(...conditions))
    .orderBy(jobs.id)
    .limit(opts.limit);
}

/**
 * Write a batch of vectors back to `jobs.embedding`, one `UPDATE ... FROM (VALUES ...)`
 * statement per chunk — a single neon-http round-trip per chunk instead of one per row.
 * pgvector accepts the textual literal `[a,b,...]` cast to `vector` in SQL (the form
 * Drizzle's typed `vector` column emits). Only `embedding` is touched; `updated_at` is
 * left alone (it tracks content changes, and the embedding is derived). Chunks at
 * MAX_ROWS_PER_WRITE to stay under Postgres's 65535 bind-param ceiling (2 params/row): the
 * backfill's default batch (64) never splits, but this guards bulk callers of this exported
 * primitive. An empty `rows` writes nothing. Returns the number of rows updated.
 */
export async function writeJobEmbeddings(
  db: Db,
  rows: { id: number; embedding: number[] }[],
): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_WRITE) {
    const chunk = rows.slice(i, i + MAX_ROWS_PER_WRITE);
    const tuples = chunk.map(
      (r) => sql`(${r.id}::int, ${vectorLiteral(r.embedding)}${VECTOR_CAST})`,
    );
    const result: unknown = await db.execute(sql`
      UPDATE ${jobs} AS j
      SET embedding = v.embedding
      FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(id, embedding)
      WHERE j.id = v.id
      RETURNING j.id
    `);
    // RETURNING gives one row per update; trust it, but fall back to the chunk size if the
    // driver result shape is unrecognized (a successful statement that didn't throw).
    const returned = resultRows(result).length;
    written += returned > 0 ? returned : chunk.length;
  }
  return written;
}

/**
 * Embed every job still missing a vector, in batches. Loops: fetch a NULL+non-empty batch
 * → embed → write. Written rows stop matching the filter, so the next fetch returns the
 * following batch and the loop ends naturally — no cursor/offset bookkeeping, because
 * jobsNeedingEmbedding excludes contentless rows in SQL (so none can be perpetually
 * re-selected and stall the loop). Idempotent and re-runnable: a failure mid-run just
 * leaves the remaining rows NULL for next time.
 *
 * `embed` is injected (see {@link EmbedFn}); jobs embed as `"document"` by default.
 * Returns the count embedded + Voyage token usage so the caller can log cost.
 */
export async function backfillJobEmbeddings(
  db: Db,
  embed: EmbedFn,
  opts: { companyId?: number; batchSize?: number; inputType?: EmbedInputType } = {},
): Promise<{ embedded: number; tokens: number }> {
  const batchSize = opts.batchSize ?? 64;
  const inputType = opts.inputType ?? "document";
  let embedded = 0;
  let tokens = 0;

  for (;;) {
    const batch = await jobsNeedingEmbedding(db, { companyId: opts.companyId, limit: batchSize });
    if (batch.length === 0) break;

    const { embeddings, usage } = await embed(
      batch.map((job) => jobEmbeddingText(job)),
      { inputType },
    );
    tokens += usage.totalTokens;

    // embed() returns one vector per input in order; assert before zipping by index.
    if (embeddings.length !== batch.length) {
      throw new Error(`embed() returned ${embeddings.length} vectors for ${batch.length} jobs.`);
    }
    const updates = batch.map((job, i) => ({ id: job.id, embedding: embeddings[i] as number[] }));
    embedded += await writeJobEmbeddings(db, updates);
  }

  return { embedded, tokens };
}

export interface JobNeighbor {
  id: number;
  title: string;
  /** Cosine distance from the query vector (`<=>`); smaller is closer. */
  distance: number;
}

/**
 * The `limit` jobs nearest to `queryVector` by cosine distance (`<=>`), via the HNSW
 * index, considering only rows that have an embedding. The digest pipeline runs the same
 * query against a user-profile vector.
 */
export async function nearestJobs(
  db: Db,
  queryVector: number[],
  limit: number,
): Promise<JobNeighbor[]> {
  const literal = vectorLiteral(queryVector);
  // Bind the (large) query vector ONCE: compute distance in the projection, then ORDER BY
  // the `distance` alias. Postgres substitutes the alias's underlying `embedding <=> $1`
  // when building the sort pathkey, so the HNSW index path still matches — but it only WINS
  // over a seqscan once the table is large, so confirm with EXPLAIN at scale (a tiny table
  // seq-scans regardless). Cast via the shared VECTOR_CAST (single dimension const).
  const result: unknown = await db.execute(sql`
    SELECT id, title, embedding <=> ${literal}${VECTOR_CAST} AS distance
    FROM ${jobs}
    WHERE embedding IS NOT NULL
    ORDER BY distance
    LIMIT ${limit}
  `);

  return resultRows(result).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: Number(r.id),
      title: typeof r.title === "string" ? r.title : String(r.title),
      distance: Number(r.distance),
    };
  });
}

/**
 * Compose the text embedded for a job. Title + description is a deliberately simple
 * starting point; the exact composition (weighting, including locations, truncation) is
 * an eval tunable. Exported so the eval harness and retrieval embed jobs the same way.
 * Voyage truncates overlong inputs (its `truncation` defaults on).
 */
export function jobEmbeddingText(job: { title: string; descriptionText: string }): string {
  return composeEmbeddingText([job.title, job.descriptionText]);
}
