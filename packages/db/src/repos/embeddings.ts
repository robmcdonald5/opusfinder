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
import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import type { Db } from "../client";
import { jobs } from "../schema";
import { resultRows, VECTOR_CAST, vectorLiteral } from "./sql";

// Cap rows per UPDATE so a large caller can't exceed Postgres's 65535 bind-param ceiling
// (3 params/row). The default backfill batch (64) is far under; this guards future bulk
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
  /** md5 of the title + description as read; writeJobEmbeddings skips the row if its text changed since. */
  contentHash: string;
}

/**
 * The non-ASCII code points JS `String.prototype.trim()` strips. POSIX `[[:space:]]` covers the ASCII ones
 * but, depending on the locale, not these, so the SQL class lists them. Built from code points so this
 * file holds no invisible characters.
 */
const UNICODE_TRIM_CHARS = String.fromCharCode(
  0xa0,
  0x1680,
  ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), // U+2000..U+200A
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x3000,
  0xfeff,
);
const HAS_CONTENT_RE = sql.raw(`'[^[:space:]${UNICODE_TRIM_CHARS}]'`);

/**
 * Title OR description_text has a character composeEmbeddingText's `.trim()` keeps. It MUST match that
 * empty-notion (see jobEmbeddingText): a row selected here that composes to "" makes Voyage 400 the whole
 * page, and the cursorless drain re-selects that page forever. If jobEmbeddingText starts composing more
 * than title + description, update this predicate in lockstep.
 */
const embeddableContentSql: SQL = sql`(${jobs.title} ~ ${HAS_CONTENT_RE} OR ${jobs.descriptionText} ~ ${HAS_CONTENT_RE})`;

/**
 * The jobs still owed a vector: no embedding, active, with content to embed. Retrieval reads only active
 * rows, so a closed job is never paid for (a revived one re-enters on the next pass). The health check's
 * `embedding_backlog` counts this same predicate, so it measures exactly the work the drain has left.
 */
export const needsEmbeddingSql: SQL = sql`${jobs.embedding} IS NULL AND ${jobs.lifecycleState} = 'active' AND ${embeddableContentSql}`;

/** md5 of exactly the text a page embeds: read with the page, re-checked by the write. */
const contentHashSql = sql<string>`md5(${jobs.title} || chr(10) || ${jobs.descriptionText})`;

/**
 * The next batch of jobs still owed a vector ({@link needsEmbeddingSql}), newest id first so fresh
 * jobs aren't queued behind an old backlog. Optionally scoped to one company (the ingestion path
 * embeds just the board it touched). `limit` bounds the batch.
 */
export async function jobsNeedingEmbedding(
  db: Db,
  opts: { companyId?: number; limit: number },
): Promise<JobNeedingEmbedding[]> {
  const conditions = [needsEmbeddingSql];
  if (opts.companyId !== undefined) conditions.push(eq(jobs.companyId, opts.companyId));

  return db
    .select({
      id: jobs.id,
      title: jobs.title,
      descriptionText: jobs.descriptionText,
      contentHash: contentHashSql,
    })
    .from(jobs)
    .where(and(...conditions))
    .orderBy(desc(jobs.id))
    .limit(opts.limit);
}

/**
 * Write a batch of vectors back to `jobs.embedding`, one `UPDATE ... FROM (VALUES ...)`
 * statement per chunk — a single neon-http round-trip per chunk instead of one per row.
 * pgvector accepts the textual literal `[a,b,...]` cast to `vector` in SQL (the form
 * Drizzle's typed `vector` column emits). Only `embedding` is touched; `updated_at` is
 * left alone (it tracks content changes, and the embedding is derived). Chunks at
 * MAX_ROWS_PER_WRITE to stay under Postgres's 65535 bind-param ceiling. An empty `rows`
 * writes nothing. Returns the number of rows written.
 *
 * A row passed with its `contentHash` (from jobsNeedingEmbedding) is written only if its title and
 * description are unchanged since that read. An ingest edit in between has already NULLed the
 * embedding for the new text; writing the old text's vector would leave it stale and never
 * re-selected. A skipped row stays NULL for the next pass. Without a hash the write is unconditional
 * (seeding a known vector).
 */
export async function writeJobEmbeddings(
  db: Db,
  rows: { id: number; embedding: number[]; contentHash?: string }[],
): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_WRITE) {
    const chunk = rows.slice(i, i + MAX_ROWS_PER_WRITE);
    const tuples = chunk.map(
      (r) =>
        sql`(${r.id}::int, ${vectorLiteral(r.embedding)}${VECTOR_CAST}, ${r.contentHash ?? null}::text)`,
    );
    const result: unknown = await db.execute(sql`
      UPDATE ${jobs}
      SET embedding = v.embedding
      FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(id, embedding, content_hash)
      WHERE ${jobs.id} = v.id AND (v.content_hash IS NULL OR ${contentHashSql} = v.content_hash)
      RETURNING ${jobs.id}
    `);
    written += resultRows(result).length;
  }
  return written;
}

/** The embedder returned a different number of vectors than texts: a deterministic bug, so a caller
 *  should fail rather than retry (each retry is a paid Voyage call). */
export class EmbedCountMismatchError extends Error {
  constructor(vectors: number, jobs: number) {
    super(`embed returned ${vectors} vectors for ${jobs} jobs`);
    this.name = "EmbedCountMismatchError";
  }
}

/**
 * Embed one page of the backlog: the next `limit` jobs owed a vector, one embed call, one write. The
 * page body shared by {@link backfillJobEmbeddings} and the Inngest drain (one page per step). `done`
 * once a page comes back short. Cursorless: written rows leave the selection, and a row skipped
 * because its text changed mid-page is re-selected with the new text.
 */
export async function embedNextPage(
  db: Db,
  embed: EmbedFn,
  opts: { companyId?: number; limit: number; inputType?: EmbedInputType },
): Promise<{ embedded: number; tokens: number; done: boolean }> {
  const batch = await jobsNeedingEmbedding(db, { companyId: opts.companyId, limit: opts.limit });
  if (batch.length === 0) return { embedded: 0, tokens: 0, done: true };

  const { embeddings, usage } = await embed(
    batch.map((job) => jobEmbeddingText(job)),
    { inputType: opts.inputType ?? "document" },
  );
  // embed() returns one vector per input in order; assert before zipping by index.
  if (embeddings.length !== batch.length) {
    throw new EmbedCountMismatchError(embeddings.length, batch.length);
  }
  const embedded = await writeJobEmbeddings(
    db,
    batch.map((job, i) => ({
      id: job.id,
      contentHash: job.contentHash,
      embedding: embeddings[i] as number[],
    })),
  );
  return { embedded, tokens: usage.totalTokens, done: batch.length < opts.limit };
}

/**
 * Embed every job still owed a vector, page by page ({@link embedNextPage}) until a page comes
 * back short. Idempotent and re-runnable: a failure mid-run just leaves the remaining rows NULL
 * for next time.
 *
 * `embed` is injected (see {@link EmbedFn}); jobs embed as `"document"` by default.
 * Returns the count embedded + Voyage token usage so the caller can log cost.
 */
export async function backfillJobEmbeddings(
  db: Db,
  embed: EmbedFn,
  opts: { companyId?: number; batchSize?: number; inputType?: EmbedInputType } = {},
): Promise<{ embedded: number; tokens: number }> {
  const limit = opts.batchSize ?? 64;
  let embedded = 0;
  let tokens = 0;

  for (;;) {
    const page = await embedNextPage(db, embed, {
      companyId: opts.companyId,
      limit,
      inputType: opts.inputType,
    });
    embedded += page.embedded;
    tokens += page.tokens;
    if (page.done) break;
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
