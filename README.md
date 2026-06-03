# opusfinder

A SaaS job-digest service: users upload a CV and preferences; the system ingests
job listings from public ATS sources, filters and ranks them per user with an LLM
pipeline, and delivers a personalized digest on a regular cadence. See
`research/specs/TECH_SPEC.md` for the full product and architecture spec.

## Monorepo layout

| Path                   | What                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/`            | SvelteKit frontend (placeholder until Phase 12)                                                                                                                 |
| `apps/scrapers/`       | Cloudflare Workers cron runtime — scheduled ingestion + discovery against Neon (Phase 8) ([README](apps/scrapers/README.md))                                    |
| `packages/db/`         | Drizzle ORM over Neon Postgres + pgvector ([README](packages/db/README.md))                                                                                     |
| `packages/discovery/`  | Slug-discovery pipeline — seed → probe → upsert + staleness (Phase 7) ([README](packages/discovery/README.md))                                                  |
| `packages/embeddings/` | Voyage `voyage-3-large` embeddings + HNSW retrieval ([README](packages/embeddings/README.md))                                                                   |
| `packages/eval/`       | Matching-quality eval harness — metrics, rankers, reports ([README](packages/eval/README.md))                                                                   |
| `packages/llm/`        | Vercel AI SDK + Anthropic wrapper, prompt caching ([README](packages/llm/README.md))                                                                            |
| `packages/shared/`     | Shared brand types + validators ([README](packages/shared/README.md))                                                                                           |
| `packages/sources/`    | ATS adapters → `NormalizedJob` (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Pinpoint, Gem, Trakstar) ([README](packages/sources/README.md)) |
| `research/`            | Specs + source-discovery catalog (local planning docs — see below)                                                                                              |

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
#
# For the LLM package (Phase 3), paste your Anthropic key into packages/llm/.env:
#   ANTHROPIC_API_KEY=sk-ant-...   (or export it as a shell env var)
#
# For the embeddings package (Phase 4), paste your Voyage key into packages/embeddings/.env:
#   VOYAGE_API_KEY=pa-...   (or export it as a shell env var)

pnpm db:migrate   # applies packages/db/drizzle (enables the pgvector extension)
pnpm db:ping      # round-trips SELECT 1 against Neon
```

## Root scripts

| Script                         | Does                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `lint:fix`       | ESLint over the repo                                                                                     |
| `pnpm format` / `format:check` | Prettier write / check                                                                                   |
| `pnpm typecheck`               | `tsc --noEmit` (covers `packages/*`; apps excluded until they gain code)                                 |
| `pnpm typecheck:scrapers`      | `tsc --noEmit` for `apps/scrapers` (the root typecheck excludes `apps/*`)                                |
| `pnpm db:migrate`              | Run Neon migrations (`@opusfinder/db`)                                                                   |
| `pnpm db:ping`                 | Connectivity check against Neon                                                                          |
| `pnpm runs`                    | Print the most recent `source_runs` rows (pipeline health at a glance)                                   |
| `pnpm ingest <source> <slug>`  | Fetch + normalize one ATS board, upsert to Neon, embed new postings (`--no-embed` to skip)               |
| `pnpm ingest:all`              | Ingest every seeded company across all sources (`[--no-embed] [--source=<name>]`)                        |
| `pnpm discover`                | Discover + validate + upsert company slugs from the seed (`[--source=<name>] [--limit=<n>] [--dry-run]`) |
| `pnpm llm:test`                | Call Haiku twice with a cached system prompt; assert cache write then read                               |
| `pnpm embeddings:backfill`     | Embed every job whose `embedding` is still NULL (idempotent)                                             |
| `pnpm embeddings:search "<q>"` | Embed a query and print the nearest jobs by cosine distance (HNSW)                                       |
| `pnpm eval`                    | Score a ranker over the labeled set; write a report + diff vs last run                                   |
| `pnpm eval:compare`            | Voyage vs OpenAI embedding retrieval, side-by-side                                                       |

## Documentation (local planning docs — not committed)

These live under `research/`, which is gitignored — present in the working tree
but not in a fresh clone:

- `research/specs/TECH_SPEC.md` — product + architecture
- `research/specs/IMPLEMENTATION_PLAN_TENATIVE.md` — canonical phased roadmap
- `research/specs/PHASE_7_PLAN.md` — the Phase 7 slug-discovery build plan
- `research/specs/PHASE_8_PLAN.md` — the Phase 8 Cloudflare Worker cron build plan
- `research/specs/OPEN_DECISIONS.md` — deferred, trigger-based decisions
- `research/sources/README.md` — source-discovery catalog

## Status

Phase 8 promoted `apps/scrapers` from a placeholder into a real Cloudflare Worker — a `scheduled()`
handler that dispatches on `controller.cron` into two crons: **ingestion** (`*/30 * * * *`) and
**discovery** (`0 3 * * SUN`). It is deployed and verified end-to-end, but currently **PAUSED**
(`crons = []`) behind a documented pause/resume toggle in `wrangler.toml`. `runIngestion(db, opts)`
was extracted into `packages/sources/src/ingest.ts` (`ingest-all.ts` is now a thin shell over it),
wiring the previously-unused `"ingestion"` arm of `source_runs`. `listCompanies` gained `activeOnly`
plus an `afterId`/`limit` id-keyset cursor (the chunked-cron lane), and a new `pnpm runs` monitor and a
`failStaleRuns()` zombie-run sweep keep `source_runs` trustworthy. Inline embedding is intentionally
left **un-wired** in the Worker (Voyage free-tier 3 RPM), so vectors are filled by
`pnpm embeddings:backfill`; re-enabling it is a documented ~3-step change.

Phase 7 added `packages/discovery` — a slug-discovery pipeline that seeds companies from a curated
GitHub list (outscal/OpenJobs, pinned), HTTP-probes each candidate by **reusing the Phase-6 adapter
request-builders** (two new descriptor members: a required `matchUrl` URL→slug inverse + an optional
`classifyProbe`), idempotently upserts the live subset, and deactivates slugs after 30 days of
consecutive failed probes — all tracked in a new `source_runs` table, with `companies` gaining
`active` / `last_probed_at` / `last_live_at` / `consecutive_probe_failures`. `pnpm discover` runs it
locally (`--source` / `--limit` / `--dry-run`); the live pinned seed resolves to ~1,677 candidates
across 8 sources (gem is seed-absent). The resilient `backoff` was lifted into
`@opusfinder/shared/async` and shared with the ingestion fetch. It moved to a Cloudflare Worker in
Phase 8.

Phase 6.5 (Wave A) shipped four more zero-hydrate ATS adapters — **Recruitee, Pinpoint, Gem,
Trakstar** — each a `SourceAdapter` descriptor + one `mapItem` with no change to the shared
plumbing (`SourceName` is now nine sources; shared `inferRemoteFromText` / `joinParts` /
`htmlToText` helpers extracted); Polymer was deferred to Wave B (it needs an N+1 hydrate + page
pagination). Phase 6 substantially complete (`packages/sources` — extracted a shared `runAdapter`
abstraction + a source→adapter registry and added Lever, Ashby, Workable, and
SmartRecruiters alongside Greenhouse; ingestion is now `pnpm ingest <source> <slug>` for
one board or `pnpm ingest:all` across every seeded company; `packages/db` gained a
`listCompanies` repo and now canonically sorts `jobs.locations` on write). Phase 5
substantially complete (`packages/eval` — a matching-quality harness scoring
precision/recall/NDCG@k over a JSONL labeled set, with a random baseline and an embedding
ranker; `pnpm eval` writes committed per-config reports and diffs the last run). Voyage
retrieval is validated on the seed set (2 profiles anonymized from real CVs × 80 real jobs);
the Voyage-vs-OpenAI head-to-head (`pnpm eval:compare`) ran and Voyage won (NDCG@10 83.2% vs
66.9%), so Voyage is the chosen provider — and the harness proved provider-agnostic, so the
choice is cheap to revisit as the labeled set scales. Phase 4 before it shipped
`packages/embeddings` (Voyage `voyage-3-large`; jobs embedded inline + via
`pnpm embeddings:backfill`; `pnpm embeddings:search "<query>"` over an HNSW cosine index).
Phase 3 shipped `packages/llm` (Vercel AI SDK + Anthropic wrapper with first-class prompt
caching; `pnpm llm:test` proves a cache write-then-read). Phases 0–2 scaffolded the monorepo +
Neon/pgvector db package, shipped the first ATS adapter (Greenhouse),
and added the `companies`/`jobs` tables with idempotent upsert. See the implementation plan for
what comes next.
