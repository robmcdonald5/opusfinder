# @opusfinder/db

Drizzle ORM over Neon Postgres, using the **neon-http** driver
(`@neondatabase/serverless`). HTTP/fetch-based, no TCP sockets — so the same
client runs in Node today and in Cloudflare Workers later (Phase 8). The package
exports raw `.ts` (no build step / no `dist`): `createDb(connectionString)`
returns a Drizzle client. Phase 2 added two subpath exports alongside it:
`@opusfinder/db/repos` (`upsertCompany` / `upsertJobs`, plus the Phase-4 embedding repo —
`backfillJobEmbeddings` / `nearestJobs` / `jobsNeedingEmbedding` / `writeJobEmbeddings` /
`jobEmbeddingText`) and `@opusfinder/db/env`
(`getDatabaseUrl`).

## Environment

The real connection string lives in `packages/db/.env` (gitignored). Copy the
repo-root `.env.example` there and set `DATABASE_URL` to your Neon **direct**
(non-pooled) connection string. `getDatabaseUrl()` (`src/env.ts`) validates it is
a `postgres(ql)://` URL and, on failure, echoes only the scheme — never the
credentials.

## Commands

Run from the repo root via the workspace filter so the cwd is `packages/db`:

| Command                                  | Does                                           |
| ---------------------------------------- | ---------------------------------------------- |
| `pnpm --filter @opusfinder/db migrate`   | Apply migrations from `./drizzle`              |
| `pnpm --filter @opusfinder/db generate`  | `drizzle-kit generate` (offline; no DB needed) |
| `pnpm --filter @opusfinder/db studio`    | Open Drizzle Studio                            |
| `pnpm --filter @opusfinder/db ping`      | Round-trip `SELECT 1` against Neon             |
| `pnpm --filter @opusfinder/db typecheck` | `tsc --noEmit`                                 |

`migrate` and `ping` are also exposed at the root as `pnpm db:migrate` / `pnpm db:ping`.

> **Cwd matters.** The scripts and `drizzle.config.ts` use **cwd-relative** paths
> (`./drizzle` for migrations, `.env` for dotenv). They must run with the cwd set
> to `packages/db` — always invoke them via `pnpm --filter @opusfinder/db <script>`
> (or `cd packages/db` first), never by pathing into the script directly.

## Caveats

- **Schema (Phase 2 + 4).** `src/schema.ts` defines `companies` (unique
  `(slug, source)`) and `jobs` (unique `(source, external_id)`, FK → `companies`,
  `company_id` index, text `lifecycle_state`). `jobs.embedding` is a nullable
  `vector(1024)` — width = the exported `EMBEDDING_DIMENSIONS` constant (the single source of truth, kept
  in sync with `@opusfinder/embeddings`' `EMBED_DIMENSIONS`); populated in Phase 4 and
  HNSW-indexed for cosine retrieval (`jobs_embedding_hnsw_idx`, `vector_cosine_ops`). pgvector is enabled
  via the SQL migration (`drizzle/0000_enable_pgvector.sql`), not declared in
  Drizzle; the tables land in `drizzle/0001_petite_namor.sql` and the HNSW index in
  `drizzle/0002_flashy_joshua_kane.sql`.
- **neon-http migrations are NOT transactional.** The neon-http migrator applies
  a migration's statements without a wrapping transaction, so a multi-statement
  migration that fails partway leaves a partial apply with no rollback (and a
  re-run starts from the top). **Keep every migration idempotent/guarded**
  (`CREATE EXTENSION IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`, …). For an unavoidably non-idempotent
  multi-statement migration, run it through the websocket `neon-serverless`
  migrator instead. (See Phase 2 notes in the implementation plan.)
- **Embeddings repo (Phase 4).** `src/repos/embeddings.ts` adds `backfillJobEmbeddings()`
  (idempotent embed → write loop over NULL-embedding rows), `nearestJobs()` (cosine
  `<=>` over the HNSW index), `jobsNeedingEmbedding()`, `writeJobEmbeddings()`, and
  `jobEmbeddingText()` (title + description — the Phase-5 eval tunable). The embedder is
  **injected** (an `EmbedFn` parameter), so `db` keeps zero dependency on
  `@opusfinder/embeddings`; the dependency points the other way. Every `::vector(N)` cast
  is built once from `EMBEDDING_DIMENSIONS`.
- **Embedding invalidation on upsert (Phase 4).** `upsertJobs` resets `embedding` to
  `NULL` only when `title` OR `description_text` changed (a `CASE` in the conflict `set`);
  changes to other fields keep the existing vector, so re-embedding cost is paid only on
  real content change.
- **0002 HNSW migration is hand-guarded.** drizzle-kit emits a bare `CREATE INDEX`;
  `0002_flashy_joshua_kane.sql` is hand-edited to `CREATE INDEX IF NOT EXISTS` because
  neon-http migrations aren't transactional (same discipline as the FK in 0001).
  `CREATE INDEX CONCURRENTLY` is deferred — the table is small and CONCURRENTLY can't run
  inside one neon-http call.
