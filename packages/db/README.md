# @opusfinder/db

Drizzle ORM over Neon Postgres, using the **neon-http** driver
(`@neondatabase/serverless`). HTTP/fetch-based, no TCP sockets — so the same
client runs in Node today and in Cloudflare Workers later (Phase 8). The package
exports raw `.ts` (no build step / no `dist`): `createDb(connectionString)`
returns a Drizzle client and is the single entry point.

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

- **Schema is empty until Phase 1+.** `src/schema.ts` is intentionally
  `export {}` — no tables yet. pgvector is enabled via the SQL migration
  (`drizzle/0000_enable_pgvector.sql`), not declared in Drizzle. Tables
  (`companies`, `jobs`, …) land from Phase 2 onward.
- **neon-http migrations are NOT transactional.** The neon-http migrator applies
  a migration's statements without a wrapping transaction, so a multi-statement
  migration that fails partway leaves a partial apply with no rollback (and a
  re-run starts from the top). **Keep every migration idempotent/guarded**
  (`CREATE EXTENSION IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`, …). For an unavoidably non-idempotent
  multi-statement migration, run it through the websocket `neon-serverless`
  migrator instead. (See Phase 2 notes in the implementation plan.)
