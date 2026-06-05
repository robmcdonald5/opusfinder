# @opusfinder/db

Drizzle ORM over Neon Postgres, using the **neon-http** driver
(`@neondatabase/serverless`). HTTP/fetch-based, no TCP sockets — so the same
client runs in Node today and in Cloudflare Workers later (Phase 8). The package
exports raw `.ts` (no build step / no `dist`): `createDb(connectionString)`
returns a Drizzle client. Phase 2 added subpath exports alongside it:
`@opusfinder/db/repos` (`upsertCompany` / `upsertJobs` / `listCompanies`; the Phase-4 embedding repo —
`backfillJobEmbeddings` / `nearestJobs` / `jobsNeedingEmbedding` / `writeJobEmbeddings` /
`jobEmbeddingText`; the Phase-7 discovery repo — `startRun` / `finishRun` / `failStaleRuns` /
`listCompaniesForReprobe` / `listCompanyStates` / `markProbeResult` / `markProbed` / `deactivateStale`;
the Phase-9 profiles repo — `insertCvFile` / `patchCvFileExtracted` / `markCvFileFailed` /
`upsertUserProfile` / `getProfileTextKey`; and the Phase-9.5 preferences repo — `getPreferences` /
`getOrCreatePreferences` / `updatePreferences`) and `@opusfinder/db/env` (`getDatabaseUrl`).

**Phase 9.5** added a second client behind `@opusfinder/db/auth-client`: `createAuthDb(connectionString)`,
a **transaction-capable neon-serverless** (WebSocket) Drizzle client. Better Auth's `signUpEmail` wraps
its `user`+`account` inserts in an interactive transaction the fetch-only neon-http `createDb` can't run
(#4747), so the auth adapter uses this handle — kept on its own subpath so the default neon-http client
is unaffected and the scrapers Worker never pulls neon-serverless/WebSocket into its bundle.

## Environment

The real connection string lives in `packages/db/.env` (gitignored). Copy the
repo-root `.env.example` there and set `DATABASE_URL` to your Neon **direct**
(non-pooled) connection string. `getDatabaseUrl()` (`src/env.ts`, built on
`@opusfinder/shared/env`'s `loadPackageEnv` + `requireEnv`) validates it is
a `postgres(ql)://` URL and, on failure, echoes only the scheme — never the
credentials. `loadPackageEnv(import.meta.url)` resolves `packages/db/.env`
relative to the module (not the cwd), so any package's scripts pick up
`DATABASE_URL` however they're invoked.

## Commands

Run from the repo root via the workspace filter so the cwd is `packages/db`:

| Command                                  | Does                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| `pnpm --filter @opusfinder/db migrate`   | Apply migrations from `./drizzle`                          |
| `pnpm --filter @opusfinder/db generate`  | `drizzle-kit generate` (offline; no DB needed)             |
| `pnpm --filter @opusfinder/db studio`    | Open Drizzle Studio                                        |
| `pnpm --filter @opusfinder/db ping`      | Round-trip `SELECT 1` against Neon                         |
| `pnpm --filter @opusfinder/db runs`      | Print the most recent `source_runs` rows (pipeline health) |
| `pnpm --filter @opusfinder/db typecheck` | `tsc --noEmit`                                             |

`migrate` and `ping` are also exposed at the root as `pnpm db:migrate` / `pnpm db:ping`.

> **Cwd matters.** `drizzle.config.ts` and the `./drizzle` migration path are
> **cwd-relative**, so db scripts must run with the cwd set to `packages/db` —
> always invoke them via `pnpm --filter @opusfinder/db <script>` (or `cd packages/db`
> first), never by pathing into the script directly. (Env loading is no longer
> cwd-relative — `getDatabaseUrl()` loads via `@opusfinder/shared/env`; see Environment above.)

## Caveats

- **Schema (Phase 2 + 4 + 7).** `src/schema.ts` defines `companies` (unique
  `(slug, source)`) and `jobs` (unique `(source, external_id)`, FK → `companies`,
  `company_id` index, text `lifecycle_state`). `jobs.embedding` is a nullable
  `vector(1024)` — width = the exported `EMBEDDING_DIMENSIONS` constant (the single source of truth, kept
  in sync with `@opusfinder/embeddings`' `EMBED_DIMENSIONS`); populated in Phase 4 and
  HNSW-indexed for cosine retrieval (`jobs_embedding_hnsw_idx`, `vector_cosine_ops`). pgvector is enabled
  via the SQL migration (`drizzle/0000_enable_pgvector.sql`), not declared in
  Drizzle; the tables land in `drizzle/0001_petite_namor.sql` and the HNSW index in
  `drizzle/0002_flashy_joshua_kane.sql`. **Phase 7** added the `source_runs` run-audit table
  (`pipeline` / `source` / `status` / `started_at` / `finished_at` / `counts` jsonb / `error_sample`;
  index `source_runs_pipeline_started_idx`) and four staleness columns on `companies` — `active`,
  `last_probed_at`, `last_live_at`, `consecutive_probe_failures` — plus the partial reprobe index
  `companies_active_last_probed_idx` (active rows, `last_probed_at ASC NULLS FIRST, id`). The
  `status`/`pipeline` fields are TS unions on plain `text` (not `pgEnum`), same idempotent-migration
  reason as `lifecycle_state`. The Phase-7 schema lands in `drizzle/0003_lame_black_tom.sql`, with
  every `CREATE TABLE` / `ADD COLUMN` / `CREATE INDEX` hand-guarded `IF NOT EXISTS`.
- **Schema (Phase 9 + 9.5).** Phase 9 added `user_cv_files` (append-only CV uploads + R2 keys) and
  `user_profiles` (one semantic profile per user — structured JSON + a `vector(1024)` HNSW-indexed
  embedding) in `drizzle/0004_curvy_shard.sql`. **Phase 9.5** added the Better Auth-owned identity
  tables `user` / `session` / `account` / `verification` (uuid ids via the `generateId: "uuid"` config)
  and the typed `user_preferences` table (filter + digest/delivery/unsubscribe settings; 1:1 FK →
  `user.id`) plus `repos/preferences.ts`, in `drizzle/0005_clammy_talisman.sql` (additive). The FKs from
  `user_cv_files.user_id` / `user_profiles.user_id` → `user.id` (ON DELETE CASCADE) were split into
  `drizzle/0006_large_diamondback.sql`: they couldn't land in 0005 because the throwaway Phase-9
  placeholder rows referenced no `user` row and would have failed FK validation until the §7b re-key wipe.
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
- **Canonical `locations` on upsert (Phase 6).** `upsertJobs` sorts each job's `locations`
  to a canonical order on write. `locations` is compared as an order-sensitive jsonb array in
  the change test, so a multi-location board that emits the same offices in a different order
  across runs would otherwise report a spurious change every ingest. (`runAdapter` already
  canonicalizes in memory; the sort here is the defense for any direct `upsertJobs` caller.)
- **0002 HNSW migration is hand-guarded.** drizzle-kit emits a bare `CREATE INDEX`;
  `0002_flashy_joshua_kane.sql` is hand-edited to `CREATE INDEX IF NOT EXISTS` because
  neon-http migrations aren't transactional (same discipline as the FK in 0001).
  `CREATE INDEX CONCURRENTLY` is deferred — the table is small and CONCURRENTLY can't run
  inside one neon-http call.
