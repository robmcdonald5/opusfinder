# opusfinder

A SaaS job-digest service: users upload a CV and preferences; the system ingests
job listings from public ATS sources, filters and ranks them per user with an LLM
pipeline, and delivers a personalized digest on a regular cadence. See
`research/specs/TECH_SPEC.md` for the full product and architecture spec.

## Monorepo layout

| Path                   | What                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/`            | SvelteKit frontend (placeholder until Phase 12)                                                                                                                                                   |
| `apps/scrapers/`       | Cloudflare Workers cron runtime — scheduled ingestion + discovery against Neon (Phase 8) ([README](apps/scrapers/README.md))                                                                      |
| `packages/auth/`       | Better Auth (email+password) — `user`/`session`/`account` schema + user-creation service + management CLIs (Phase 9.5; node/server-only, never in the Worker) ([README](packages/auth/README.md)) |
| `packages/db/`         | Drizzle ORM over Neon Postgres + pgvector ([README](packages/db/README.md))                                                                                                                       |
| `packages/discovery/`  | Slug-discovery pipeline — seed lanes (outscal + HN) → probe → upsert + staleness (Phase 7; F5 lane registry) ([README](packages/discovery/README.md))                                                                                    |
| `packages/embeddings/` | Voyage `voyage-3-large` embeddings + HNSW retrieval ([README](packages/embeddings/README.md))                                                                                                     |
| `packages/eval/`       | Matching-quality eval harness — metrics, rankers, reports ([README](packages/eval/README.md))                                                                                                     |
| `packages/inngest/`    | Per-user digest pipeline on Inngest — orchestrator + per-user fn, local serve + trigger CLI (Phase 10; local-dev-only) ([README](packages/inngest/README.md))                                     |
| `packages/llm/`        | Vercel AI SDK + Anthropic wrapper, prompt caching, structured output, Message Batches (Phase 10) ([README](packages/llm/README.md))                                                               |
| `packages/profiles/`   | CV → semantic-profile pipeline — transcribe → structure → embed (Phase 9) ([README](packages/profiles/README.md))                                                                                 |
| `packages/rerank/`     | Shared listwise LLM rerank core — `RerankCall` injection, runs in both the digest pipeline and eval (Phase 10) ([README](packages/rerank/README.md))                                              |
| `packages/shared/`     | Shared brand types + validators ([README](packages/shared/README.md))                                                                                                                             |
| `packages/sources/`    | ATS adapters → `NormalizedJob` (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Pinpoint, Gem, Trakstar) ([README](packages/sources/README.md))                                   |
| `packages/storage/`    | S3-compatible Cloudflare R2 client for CV artifacts (Phase 9) ([README](packages/storage/README.md))                                                                                              |
| `research/`            | Specs + source-discovery catalog (local planning docs — see below)                                                                                                                                |

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
#
# For the storage package (Phase 9), put your Cloudflare R2 credentials in packages/storage/.env:
#   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME + R2_ACCOUNT_ID (or S3_ENDPOINT_URL)
#
# For the auth package (Phase 9.5), put a self-generated signing secret in packages/auth/.env:
#   BETTER_AUTH_SECRET=...   (openssl rand -base64 32)   [+ optional BETTER_AUTH_URL]

pnpm db:migrate   # applies packages/db/drizzle (enables the pgvector extension)
pnpm db:ping      # round-trips SELECT 1 against Neon
```

## Root scripts

| Script                                    | Does                                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint` / `lint:fix`                  | ESLint over the repo                                                                                                                                                           |
| `pnpm format` / `format:check`            | Prettier write / check                                                                                                                                                         |
| `pnpm typecheck`                          | `tsc --noEmit` (covers `packages/*`; apps excluded until they gain code)                                                                                                       |
| `pnpm typecheck:scrapers`                 | `tsc --noEmit` for `apps/scrapers` (the root typecheck excludes `apps/*`)                                                                                                      |
| `pnpm db:migrate`                         | Run Neon migrations (`@opusfinder/db`)                                                                                                                                         |
| `pnpm db:backfill-signatures`             | Backfill `jobs.content_signature` for unsigned rows (idempotent; Phase F1d)                                                                                                    |
| `pnpm db:ping`                            | Connectivity check against Neon                                                                                                                                                |
| `pnpm runs`                               | Print the most recent `source_runs` rows (pipeline health at a glance)                                                                                                         |
| `pnpm health`                             | Run the pipeline health checker over Neon — print 8 checks + a cost rollup; on an enforce-mode firing email `ALERT_TO` + exit non-zero (Phase F6)                              |
| `pnpm ingest <source> <slug>`             | Fetch + normalize one ATS board, upsert to Neon, embed new postings (`--no-embed` to skip)                                                                                     |
| `pnpm ingest:all`                         | Ingest every seeded company across all sources (`[--no-embed] [--source=<name>]`)                                                                                              |
| `pnpm discover`                           | Discover + validate + upsert company slugs from the seed lanes (`[--source=<name>] [--lanes=<a,b>] [--limit=<n>] [--dry-run]`)                                                  |
| `pnpm llm:test`                           | Call Haiku twice with a cached system prompt; assert cache write then read                                                                                                     |
| `pnpm embeddings:backfill`                | Embed every job whose `embedding` is still NULL (idempotent)                                                                                                                   |
| `pnpm embeddings:search "<q>"`            | Embed a query and print the nearest jobs by cosine distance (HNSW)                                                                                                             |
| `pnpm enrich:backfill`                    | Extract a structured YoE/salary band into `jobs` for un-enriched rows via Haiku (idempotent; Phase F4)                                                                         |
| `pnpm eval`                               | Score a ranker over the labeled set; write a report + diff vs last run                                                                                                         |
| `pnpm eval:compare`                       | Voyage vs OpenAI embedding retrieval, side-by-side                                                                                                                             |
| `pnpm eval:extraction`                    | Per-field extraction-accuracy eval (confusion matrix; keyless stub default, `-- --live` for real Haiku; Phase F4)                                                             |
| `pnpm ingest-cv <cv.pdf> <email>`         | Ingest a CV PDF → R2 + `user_cv_files` + `user_profiles` (transcribe → structure → embed)                                                                                      |
| `pnpm profiles:restructure <email>`       | Re-structure a profile from the cached R2 transcript (skips transcribe)                                                                                                        |
| `pnpm user:create --email … --password …` | Create a verified user + default prefs (`[--name] [--location-mode] [--locations] [--min-salary] [--max-salary] [--min-yoe] [--max-yoe] [--dealbreakers] [--exclusions] [--recency-days] [--cadence] [--enabled]`) |
| `pnpm user:set-prefs --email … [flags]`   | Patch a user's preferences (same pref flags)                                                                                                                                   |
| `pnpm user:list`                          | List users — masked email, verified, cadence, enabled, has-profile, id                                                                                                         |
| `pnpm digest`                             | Trigger a per-user digest run + poll for the result (`--user <uuid>` or `--all`; `[--timeout-ms] [--poll-ms]`)                                                                 |
| `pnpm inngest:serve`                      | Local Inngest serve endpoint for the digest functions (bare Node http, port 3000; dev-only)                                                                                    |
| `pnpm inngest:dev`                        | Local Inngest dev server (keyless; registers the serve URL for discovery + invocation)                                                                                         |
| `pnpm guard:worker`                       | Assert auth / neon-serverless / the Inngest digest stack (`inngest`, `@opusfinder/llm`, `@opusfinder/rerank`, `@anthropic-ai/sdk`) never leak into the scrapers Worker (#6665) |

## Documentation (local planning docs — not committed)

These live under `research/`, which is gitignored — present in the working tree
but not in a fresh clone:

- `research/specs/TECH_SPEC.md` — product + architecture
- `research/specs/IMPLEMENTATION_PLAN.md` — canonical phased roadmap
- `research/specs/PHASE_7_PLAN.md` — the Phase 7 slug-discovery build plan
- `research/specs/PHASE_8_PLAN.md` — the Phase 8 Cloudflare Worker cron build plan
- `research/specs/PHASE_9_PLAN.md` — the Phase 9 CV-ingestion build plan
- `research/specs/PHASE_9.5_PLAN.md` — the Phase 9.5 user-identity (Better Auth) build plan
- `research/specs/PHASE_10_PLAN.md` — the Phase 10 per-user digest pipeline (Inngest) build plan
- `research/specs/PHASE_11_PLAN.md` — the Phase 11 email-delivery (Resend) build plan
- `research/specs/OPEN_DECISIONS.md` — deferred, trigger-based decisions
- `research/sources/README.md` — source-discovery catalog

## Status

Phase F6 added **pipeline health & alerting** — the watcher for health data that was recorded everywhere but
read nowhere. A new pure, serverless-safe checker (`@opusfinder/db/health`, **NO migration**) computes eight
liveness checks (ingestion staleness, board fail-ratio, discovery window, embedding + enrichment backlogs, digest
errors, bounce/suppression, discovery lane-errors) + a rerank-cache cost rollup from existing columns, behind
`off|shadow|enforce` modes (shadow-first). `pnpm health` (in `@opusfinder/inngest`, reusing both db + email) prints the report and emails the
operator (a new `sendHealthAlert` in `@opusfinder/email` → a dedicated `ALERT_TO`) on an enforce-firing check. The
scrapers Worker fires a content-free watchdog heartbeat (`HEALTH_PING_URL`) on each successful ingestion tick to
catch the cron's own death, and **ingestion is resumed hourly** (`0 * * * *`, dialed back from `*/30`; deployed
live 2026-06-15); F5 also **resumed the weekly discovery cron** (`0 3 * * SUN`). Uncommitted on `main`.

Phase F5 added **discovery scale-out** — a `SeedLane` registry (`SEED_LANES`) replaces the single
`loadSeed()` call with a per-lane loop (`selectLanes` / `resolveLanes`; isolated non-`failLoud` lanes
tally `lane_<name>_error` and continue; counts accumulate field-wise; candidates cross-lane-dedupe by
`(source, slug)`). A NEW **`hn` lane** (`lanes/hn.ts`) mines the monthly HN "Who is hiring?" thread via
fetch-only Algolia calls + a regex over covered ATS board URLs (Worker-safe, reusing
`@opusfinder/sources` `cleanHtml(["decode"])` to decode `&#x2F;`-encoded URLs). `pnpm discover` gains
`--lanes`; the weekly Worker discovery cron is **RESUMED** (`0 3 * * SUN`, Workers Paid) via
`runDiscovery({ workerOnly: true })`; the health checker gains an 8th check (`discovery_lane_errors`);
`discoveryMaxAgeD` 8→13; `@opusfinder/sources` now exports `cleanHtml` / `htmlToText` / `CleanStep`.
**Scope: registry + HN only** (passive DNS + Common Crawl → F5-LANES-2); **NO migration**. Uncommitted
on `main`.

Phase F4 added **job-side structured enrichment at ingest**: an async Haiku pass extracts a numeric **YoE
band** (`yoe_min` / `yoe_max`) and a structured **salary band** (`salary_min` / `salary_max` +
`salary_currency` / `salary_period`) from each posting's own title + description into seven new nullable
`jobs` columns, gated by an **`enriched_at` SENTINEL** (NULL = not-yet-extracted — distinct from a successful
"found nothing", where the data columns are legitimately all-NULL). The lifecycle mirrors the embedding
backfill (`packages/db/src/repos/enrichment.ts` — `jobsNeedingEnrichment` / `writeJobEnrichment` /
`backfillJobEnrichment` over an injected `ExtractFn` + a keyset cursor), and `upsertJobs` resets enrichment
alongside the embedding on a title/description change. The extractor is `@opusfinder/llm`'s `JOB_ENRICH_SYSTEM`
+ `JobEnrichmentSchema` (strict null-when-absent, per-field `.catch(null)` bounds, Haiku temp 0), with a new
per-field confusion-matrix accuracy eval (`pnpm eval:extraction`, distinct from the permutation-locked Ranker).
**Path A**: a numeric YoE band, NO categorical `seniority_band` — F3 dropped `target_level`, so the YoE band is
the sole declared-level signal on both sides. Live: 1472 jobs enriched (880 YoE / 385 salary / 542
found-nothing); eval — salary 0% hallucination / 100% accuracy, YoE ~94% (haiku beat Sonnet on YoE, so
F4-MODEL locks to haiku). Migration 0013 applied to prod. **SCOPE: DATA + extraction + eval only — the
salary/YoE retrieval `WHERE` clauses are the deferred, twice-gated F4-FILTER follow-on.** Uncommitted on branch
`feat/job-enrichment`.

Phase F3 added **user preferences** as a hard-filter + soft-prompt layer. A new `location_mode`
(`any` / `remote_only` / `onsite_only`) hard filter subsumes the old `remote_ok` boolean in retrieval;
min/max salary and a YoE band (`yoe_min` / `yoe_max`) are stored and fed to rerank/synthesis as a
**soft prompt signal only** (hard salary/YoE filters deferred to F4), and `dealbreakers` merge into the
exclusions list. A digest **quality floor** (`MIN_SCORE=0.5`) drops sub-floor reranked items before the
top-K cut and skips synthesis/send entirely when none clear. `target_level` was dropped — the YoE band
is the sole declared-level signal. Migration 0012 applied; backend-only; live self-send passed. Uncommitted
on branch `feat/user-preferences`.

Phase 11 adds **email delivery** on **Resend**: the per-user digest function now ends with a send →
bounded-delivery-poll → record tail (`packages/inngest/src/delivery.ts`). A new **`@opusfinder/email`**
package splits a PURE, byte-deterministic render (escaped HTML + text part — scraped titles/reasons are
hostile input; `javascript:` apply URLs degrade to inert text) from the only `resend` import (send with
`Idempotency-Key: digest/<digestId>` so step retries can't double-send, fail-closed `EMAIL_ALLOWLIST`).
Delivery state lands per-send on `digests` (`email_id`/`delivery_status`/`sent_at`, migration 0009) and
user-level on `user_preferences` (bounce → hard-suppress; complaint → suppress without a bounce write).
**LOCAL-DEV-ONLY, manual trigger**: the cadence cron, Inngest Cloud keys, production serve, webhooks,
and the unsubscribe endpoint are all Phase 12. Sending domain: `send.opusfinder.ai` (verified on Resend,
SPF/DKIM/DMARC). Gates: `pnpm email:preview` (hostile-fixture render, no creds),
`pnpm --filter @opusfinder/inngest test:digest-email` (stub smoke), and the live inbox gate.

Phase 10 added the **per-user digest pipeline** on **Inngest** — generation only; the cadence cron is
Phase 12. A run does deterministic filter → pgvector retrieval (top ~50 vs `user_profiles.embedding`)
→ **synchronous** Haiku rerank (a prompt-cached rubric + profile) → **batched** Sonnet synthesis (Anthropic
Message Batches API, 50% discount) → persisted `digests` / `digest_items` rows that double as the
"never re-surface a job" dedup history (≈$0.03/user). Two new packages: **`@opusfinder/inngest`** (the
durable orchestrator + per-user function + a `pnpm digest` trigger CLI) and **`@opusfinder/rerank`** (a
pure, shared listwise rerank core whose `rerankCandidates` runs in BOTH the digest pipeline and the eval
harness). `packages/llm` gained an Anthropic Message Batches lifecycle (`batch.ts`, on the raw
`@anthropic-ai/sdk` — the Vercel AI SDK has no batch support) plus the digest/rerank prompts; `packages/db`
added `digest_runs` / `digests` / `digest_items` (migrations 0007–0008) and the `retrieval` / `digests` /
`runs` repos. **LOCAL-DEV-ONLY**: it runs against a local Inngest dev server (`pnpm inngest:dev`, keyless)
with `INNGEST_DEV=1`; the deployed serve endpoint + Cloud keys are Phase 12. `pnpm guard:worker` now also
keeps `@opusfinder/llm` / `@opusfinder/rerank` / `@anthropic-ai/sdk` / `inngest` out of the scrapers
Worker. Shipped on branch `feat/inngest-digest-pipeline` (PR #15).

Phase 9.5 added the **user & identity foundation** (backend/CLI only — no UI). **Better Auth**
(email+password) owns `user` / `session` / `account` / `verification` in Neon via the Drizzle adapter,
alongside a typed **`user_preferences`** table (filter + digest/delivery settings) and FKs from
`user_cv_files` / `user_profiles` onto `user.id`. A new **`@opusfinder/auth`** package exposes
`createUserWithProfile` / `getOrCreateUserByEmail` — the one creation path the CLI now and the Phase-12
signup form will both call — plus `pnpm user:create` / `user:set-prefs` / `user:list`. The throwaway
email-derived `mintUserId` placeholder is retired from the live path (`ingest-cv` now resolves a real
`user.id`), and a latent IDOR in the cv-file repo is closed. Better Auth needs a transaction-capable
driver, so the auth adapter uses a neon-serverless client (`createAuthDb`) kept behind a subpath and
**out of the scrapers Worker** (Better Auth crashes under `nodejs_compat`, #6665) — `pnpm guard:worker`
enforces that invariant. Shipped on branch `feat/phase-9.5-user-identity`.

Phase 9 added **CV ingestion**: a CV PDF becomes a semantic `user_profiles` row — structured
`{ summary, skills, targetRoles }` JSON plus a Voyage query embedding — with the original PDF and a
cached transcript living in Cloudflare R2. Two new packages: **`@opusfinder/storage`** (an
S3-compatible R2 client behind a `StorageClient` seam) and **`@opusfinder/profiles`** (the `ingestCv`
pipeline + the `restructure` re-run seam, all dependency-injected and Worker-portable), plus
`packages/llm` gaining `generateObject` + PDF document-block input + the `cv-extract` prompts, and new
`user_profiles` / `user_cv_files` tables. `pnpm ingest-cv <cv.pdf> <email>` runs the pipeline —
transcribe (Haiku vision) → structure (Haiku + Zod, PII-scrubbed) → embed (Voyage) → upsert — and the
end-to-end gate is green. Identity is a throwaway hand-minted UUIDv5-from-email (real accounts arrive
in Phase 12); the embedding is high-signal only (contact details dropped). Shipped on branch
`feat/cv-ingestion`.

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
