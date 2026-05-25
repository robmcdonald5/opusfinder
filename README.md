# opusfinder

A SaaS job-digest service: users upload a CV and preferences; the system ingests
job listings from public ATS sources, filters and ranks them per user with an LLM
pipeline, and delivers a personalized digest on a regular cadence. See
`research/specs/TECH_SPEC.md` for the full product and architecture spec.

## Monorepo layout

| Path                | What                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `apps/web/`         | SvelteKit frontend (placeholder until Phase 12)                                               |
| `apps/scrapers/`    | Cloudflare Workers scraper runtime (placeholder until Phase 8)                                |
| `packages/db/`      | Drizzle ORM over Neon Postgres + pgvector ([README](packages/db/README.md))                   |
| `packages/shared/`  | Shared brand types + validators ([README](packages/shared/README.md))                         |
| `packages/sources/` | ATS adapters → `NormalizedJob` (Greenhouse in Phase 1) ([README](packages/sources/README.md)) |
| `research/`         | Specs + source-discovery catalog (local planning docs — see below)                            |

pnpm workspaces; the package manager is pinned to pnpm 11.3.0.

## Prerequisites

- Node >= 24
- pnpm >= 11 (pinned to 11.3.0 via the `packageManager` field)

## Setup

```sh
pnpm install

# Create the db package's env file and paste your Neon connection string:
#   copy .env.example  ->  packages/db/.env   then set DATABASE_URL
# Use the DIRECT (non-pooled) Neon host. See .env.example for the format.

pnpm db:migrate   # applies packages/db/drizzle (enables the pgvector extension)
pnpm db:ping      # round-trips SELECT 1 against Neon
```

## Root scripts

| Script                         | Does                                                                     |
| ------------------------------ | ------------------------------------------------------------------------ |
| `pnpm lint` / `lint:fix`       | ESLint over the repo                                                     |
| `pnpm format` / `format:check` | Prettier write / check                                                   |
| `pnpm typecheck`               | `tsc --noEmit` (covers `packages/*`; apps excluded until they gain code) |
| `pnpm db:migrate`              | Run Neon migrations (`@opusfinder/db`)                                   |
| `pnpm db:ping`                 | Connectivity check against Neon                                          |
| `pnpm fetch:greenhouse <slug>` | Fetch + normalize one Greenhouse board and print it (no DB yet)          |

## Documentation (local planning docs — not committed)

These live under `research/`, which is gitignored — present in the working tree
but not in a fresh clone:

- `research/specs/TECH_SPEC.md` — product + architecture
- `research/specs/IMPLEMENTATION_PLAN_TENATIVE.md` — canonical phased roadmap
- `research/specs/OPEN_DECISIONS.md` — deferred, trigger-based decisions
- `research/sources/README.md` — source-discovery catalog

## Status

Phase 1 complete (Greenhouse ATS adapter — `pnpm fetch:greenhouse <slug>` fetches and
normalizes a board into in-memory `NormalizedJob`s; no DB yet). Phase 0 before it
scaffolded the monorepo + Neon/pgvector db package. See the implementation plan for
what comes next.
