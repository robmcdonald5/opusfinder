/**
 * Job-embedding persistence. Read the rows still missing a vector, write a
 * batch of vectors back, drive the embed → write loop (identical text is embedded once and its
 * vector shared), and run cosine nearest-neighbour retrieval.
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
import { intArrayLiteral, resultRows, textArrayLiteral, VECTOR_CAST, vectorLiteral } from "./sql";

// Cap rows per UPDATE so a large caller can't exceed Postgres's 65535 bind-param ceiling
// (3 params/row). The default backfill batch (64) is far under; this guards future bulk
// callers of writeJobEmbeddings.
const MAX_ROWS_PER_WRITE = 1000;

/** Voyage retrieval hint, redeclared structurally so `db` need not import embeddings. */
type EmbedInputType = "query" | "document" | null;

/**
 * The embedder shape this module needs. The real `embed` from `@opusfinder/embeddings`
 * is structurally assignable (its optional params are compatible), so callers pass it directly.
 * `model` is the id of the model that produced the vectors; it is stored beside each one.
 *
 * Called with no texts it returns its `model` and makes no provider request (the real `embed`
 * short-circuits an empty input). embedNextPage asks this way which model's stored vectors it may reuse.
 */
type EmbedFn = (
  texts: string[],
  params: { inputType: EmbedInputType },
) => Promise<{ embeddings: number[][]; usage: { totalTokens: number }; model: string }>;

/**
 * A vector and the id of the model that produced it. Two models embed into different spaces, so a
 * distance between their vectors means nothing: every read that compares vectors takes the query as
 * this pair and reads only rows whose `embedding_model` equals `model`.
 */
export interface TaggedVector {
  embedding: number[];
  model: string;
}

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
 * Drizzle's typed `vector` column emits). Only `embedding` and its `embedding_model` tag (`model`,
 * the id the embedder reported for these vectors) are touched; `updated_at` is
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
  model: string,
): Promise<number> {
  return (await writeEmbeddingRows(db, rows, model)).length;
}

/** {@link writeJobEmbeddings}, returning the ids written. */
async function writeEmbeddingRows(
  db: Db,
  rows: { id: number; embedding: number[]; contentHash?: string }[],
  model: string,
): Promise<number[]> {
  const written: number[] = [];
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_WRITE) {
    const chunk = rows.slice(i, i + MAX_ROWS_PER_WRITE);
    const tuples = chunk.map(
      (r) =>
        sql`(${r.id}::int, ${vectorLiteral(r.embedding)}${VECTOR_CAST}, ${r.contentHash ?? null}::text)`,
    );
    const result: unknown = await db.execute(sql`
      UPDATE ${jobs}
      SET embedding = v.embedding, embedding_model = ${model}
      FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(id, embedding, content_hash)
      WHERE ${jobs.id} = v.id AND (v.content_hash IS NULL OR ${contentHashSql} = v.content_hash)
      RETURNING ${jobs.id}
    `);
    written.push(...writtenIds(result));
  }
  return written;
}

/** The ids an `UPDATE ... RETURNING id` wrote. */
function writtenIds(result: unknown): number[] {
  return resultRows(result).map((row) => Number((row as { id: unknown }).id));
}

/**
 * Give each job on a page the vector of a stored job with the same text, where there is one: a
 * server-side copy, so no vector crosses the wire and nothing is sent to the provider. Returns the
 * ids filled.
 *
 * The source is found through `content_signature` (indexed) but must match on the title and
 * description themselves. The signature folds case and whitespace, so two rows can share one and
 * still embed differently; equal title + description is exactly equal {@link jobEmbeddingText}. A
 * blank-description job has no signature, so it finds no source here.
 *
 * Only a vector of `model` is copied, with its row's tag: after a model swap the old vectors stay
 * out, and the job is embedded on the new model. The source may be closed; its vector is as good.
 *
 * The same content-hash guard as writeJobEmbeddings: a job whose text changed since the page was
 * read is left NULL. `need` re-reads the target row because a LATERAL subquery can't reference an
 * UPDATE's target.
 */
async function copyStoredEmbeddings(
  db: Db,
  page: JobNeedingEmbedding[],
  model: string,
): Promise<number[]> {
  const result: unknown = await db.execute(sql`
    UPDATE ${jobs}
    SET embedding = source.embedding, embedding_model = source.embedding_model
    FROM unnest(
      ${intArrayLiteral(page.map((job) => job.id))}::int[],
      ${textArrayLiteral(page.map((job) => job.contentHash))}::text[]
    ) AS v(id, content_hash)
    JOIN jobs AS need ON need.id = v.id
    CROSS JOIN LATERAL (
      SELECT src.embedding, src.embedding_model
      FROM jobs AS src
      WHERE src.content_signature = need.content_signature
        AND src.embedding_model = ${model}
        AND src.title = need.title
        AND src.description_text = need.description_text
      LIMIT 1
    ) AS source
    WHERE ${jobs.id} = v.id AND ${jobs.embedding} IS NULL AND ${contentHashSql} = v.content_hash
    RETURNING ${jobs.id}
  `);
  return writtenIds(result);
}

/** The embedder returned a different number of vectors than texts: a deterministic bug, so a caller
 *  should fail rather than retry (each retry is a paid Voyage call). */
export class EmbedCountMismatchError extends Error {
  constructor(vectors: number, jobs: number) {
    super(`embed returned ${vectors} vectors for ${jobs} jobs`);
    this.name = "EmbedCountMismatchError";
  }
}

/** One page's outcome. `embedded + reused` is the number of jobs that left the backlog. */
export interface EmbedPageResult {
  /** Jobs given a vector the provider computed for them on this page: one per distinct text. */
  embedded: number;
  /** Jobs given a vector at no provider cost: a stored job's, or the one just computed for the same
   *  text on this page. */
  reused: number;
  /** Provider tokens the page used. */
  tokens: number;
  done: boolean;
}

/**
 * Embed one page of the backlog: the next `limit` jobs owed a vector. The page body shared by
 * {@link backfillJobEmbeddings} and the Inngest drain (one page per step). Identical text is paid
 * for once:
 *   1. a job whose text a stored job already holds a vector for (of the embedder's model) takes a
 *      copy ({@link copyStoredEmbeddings});
 *   2. the rest go to the provider as one embed call, each distinct text once, and the result is
 *      written to every job with that text.
 * A page that is all copies makes no provider call.
 *
 * `done` once a page comes back short. Cursorless: written rows leave the selection, and a row skipped
 * because its text changed mid-page is re-selected with the new text.
 */
export async function embedNextPage(
  db: Db,
  embed: EmbedFn,
  opts: { companyId?: number; limit: number; inputType?: EmbedInputType },
): Promise<EmbedPageResult> {
  const batch = await jobsNeedingEmbedding(db, { companyId: opts.companyId, limit: opts.limit });
  if (batch.length === 0) return { embedded: 0, reused: 0, tokens: 0, done: true };
  const done = batch.length < opts.limit;
  const inputType = opts.inputType ?? "document";

  // An empty batch costs nothing and names the model (see EmbedFn).
  const { model: currentModel } = await embed([], { inputType });
  const copied = new Set(await copyStoredEmbeddings(db, batch, currentModel));

  const byText = new Map<string, JobNeedingEmbedding[]>();
  for (const job of batch) {
    if (copied.has(job.id)) continue;
    const text = jobEmbeddingText(job);
    const sameText = byText.get(text);
    if (sameText) sameText.push(job);
    else byText.set(text, [job]);
  }
  if (byText.size === 0) return { embedded: 0, reused: copied.size, tokens: 0, done };

  const groups = [...byText.values()];
  const { embeddings, usage, model } = await embed([...byText.keys()], { inputType });
  // embed() returns one vector per input in order; assert before zipping by index.
  if (embeddings.length !== groups.length) {
    throw new EmbedCountMismatchError(embeddings.length, groups.length);
  }
  const written = new Set(
    await writeEmbeddingRows(
      db,
      groups.flatMap((group, i) =>
        group.map((job) => ({
          id: job.id,
          contentHash: job.contentHash,
          embedding: embeddings[i] as number[],
        })),
      ),
      model,
    ),
  );
  // The first job written for a text is the one embedded; the others with that text reused its vector.
  const embedded = groups.filter((group) => group.some((job) => written.has(job.id))).length;
  return {
    embedded,
    reused: copied.size + written.size - embedded,
    tokens: usage.totalTokens,
    done,
  };
}

/**
 * Embed every job still owed a vector, page by page ({@link embedNextPage}) until a page comes
 * back short. Idempotent and re-runnable: a failure mid-run just leaves the remaining rows NULL
 * for next time.
 *
 * `embed` is injected (see {@link EmbedFn}); jobs embed as `"document"` by default.
 * Returns the counts embedded and reused ({@link EmbedPageResult}) + Voyage token usage so the
 * caller can log cost.
 */
export async function backfillJobEmbeddings(
  db: Db,
  embed: EmbedFn,
  opts: { companyId?: number; batchSize?: number; inputType?: EmbedInputType } = {},
): Promise<{ embedded: number; reused: number; tokens: number }> {
  const limit = opts.batchSize ?? 64;
  let embedded = 0;
  let reused = 0;
  let tokens = 0;

  for (;;) {
    const page = await embedNextPage(db, embed, {
      companyId: opts.companyId,
      limit,
      inputType: opts.inputType,
    });
    embedded += page.embedded;
    reused += page.reused;
    tokens += page.tokens;
    if (page.done) break;
  }

  return { embedded, reused, tokens };
}

export interface JobNeighbor {
  id: number;
  title: string;
  /** Cosine distance from the query vector (`<=>`); smaller is closer. */
  distance: number;
}

/**
 * The `limit` jobs nearest to `query` by cosine distance (`<=>`), an exact scan over the rows embedded
 * by the query's model. Otherwise unfiltered, so digest retrieval doesn't use it (see retrieval.ts).
 */
export async function nearestJobs(
  db: Db,
  query: TaggedVector,
  limit: number,
): Promise<JobNeighbor[]> {
  const literal = vectorLiteral(query.embedding);
  // Bind the (large) query vector ONCE: compute distance in the projection, then ORDER BY
  // the `distance` alias. Cast via the shared VECTOR_CAST (single dimension const).
  const result: unknown = await db.execute(sql`
    SELECT id, title, embedding <=> ${literal}${VECTOR_CAST} AS distance
    FROM ${jobs}
    WHERE embedding_model = ${query.model}
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
