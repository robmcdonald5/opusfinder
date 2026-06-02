# @opusfinder/sources

ATS adapters that fetch public job-board postings and normalize them into the shared
`NormalizedJob` shape, then persist them through `@opusfinder/db`. Phase 6 covers all five
Launch-5 ATS — **Greenhouse, Lever, Ashby, Workable, SmartRecruiters** — behind one shared
abstraction.

## Architecture

The abstraction was **extracted** from concrete Greenhouse + Lever + SmartRecruiters adapters
(not designed up front). It has three parts:

- **`runAdapter` (`src/adapters/run-adapter.ts`)** — the invariant plumbing, identical for
  every source: slug normalization → the pagination loop (`jobsRequest` → fetch → `locate` →
  `mapItem`) → the single resilient fetch (retry + exponential backoff + `Retry-After`, with a
  non-JSON-body guard) → two-tier resilience (`locate` fails LOUD on a bad envelope; `mapItem`
  fails SOFT, skipping one bad posting) → the optional bounded-concurrency hydrate pool →
  per-board accounting. Returns `NormalizedJob[]`.
- **`SourceAdapter` descriptors (`src/adapters/{greenhouse,lever,ashby,workable,smartrecruiters}.ts`)**
  — per-source data: `source`, `normalizeSlug`, `jobsRequest`, `locate`, `mapItem`, and the
  optional `nextCursor` (pagination) / `hydrate` (a second fetch). `mapItem` is a typed
  function per source — never declarative config. See `src/adapters/types.ts`.
- **`cleanHtml(input, steps)` (`src/adapters/text.ts`)** — the shared HTML→text primitive. The
  decode/strip/collapse atoms are invariant; only their ORDER varies per source, so it takes
  an ordered step list (e.g. Greenhouse's asymmetric double-encoding needs
  `["decode","strip","decode","collapse"]`).

The registry (`src/adapters/index.ts`) maps `SourceName → SourceAdapter` as a
`Record<SourceName, SourceAdapter>`, so a forgotten adapter is a **compile error**. The public
entry point is `fetchJobs(source, slug)`. Adding a platform is a descriptor + one `mapItem` —
no new plumbing.

## Usage

```sh
# Ingest one board on a given ATS (fetch → normalize → upsert → embed):
pnpm ingest <source> <slug>            # e.g. pnpm ingest greenhouse vercel
pnpm ingest lever leverdemo
pnpm ingest ashby Notion
pnpm ingest workable fuku
pnpm ingest smartrecruiters Visa
#   <source> ∈ greenhouse | lever | ashby | workable | smartrecruiters
#   add --no-embed to skip the Voyage embedding step

# Ingest every seeded company across all sources (iterates the `companies` table):
pnpm ingest:all                        # [--no-embed] [--source=<name>]
```

Each board upserts via `@opusfinder/db` (`upsertCompany` + `upsertJobs`), then embeds the
new/changed postings via `@opusfinder/embeddings` (best-effort: a Voyage failure is warned, not
fatal; skipped when `VOYAGE_API_KEY` is unset or `--no-embed` is passed). `ingest:all` isolates
each board in a try/catch — one dead slug doesn't halt the run.

## Per-adapter quirks (institutional memory)

**Greenhouse** — `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`. Unpaginated
`{ jobs, meta }`. `content` is DOUBLE-entity-encoded (tags single-encoded, inner text entities
double-encoded) → decode→strip→decode→collapse. Slugs lowercase. `remote` inferred from the
location string. `postedAt` = `first_published` ‖ `updated_at`.

**Lever** — `api.lever.co/v0/postings/{slug}?mode=json`. Response is a BARE array (no envelope).
Slugs CASE-SENSITIVE (don't lowercase). `id` is a UUID string; title is on `text`; `createdAt`
is ms-epoch. Structured `workplaceType` (`remote`⇒true, `hybrid`/`onsite`⇒false). Description
from `descriptionPlain` (collapse only); the `lists[]`/`additional` sections stay on `raw`.
**US host only** — EU tenants (`api.eu.lever.co`) are deferred to Phase 7.

**Ashby** — `api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`. Unpaginated
`{ jobs, apiVersion }`. Slugs case-PRESERVED (server is case-insensitive but apply URLs echo
casing — seed one canonical casing per board). `isRemote` is a TRAP (true on Hybrid postings);
`remote` is derived from `workplaceType` (null ⇒ infer from location text). Multi-office via
`location` + `secondaryLocations[]`. Description from `descriptionPlain`.

**Workable** — `apply.workable.com/api/v1/widget/accounts/{slug}?details=true`. Unpaginated
(returns the whole board in one response). Hydration is INLINE via `?details=true` (not an N+1;
the per-job widget path 404s). Slugs lowercase. `id` is `shortcode`; `remote` from
`telecommuting` ‖ text; `published_on`/`created_at` are `YYYY-MM-DD`. The host RATE-LIMITS rapid
calls (429 with an HTML body) — runAdapter's backoff + non-JSON guard handle it; `ingest:all`
paces between boards.

**SmartRecruiters** — `api.smartrecruiters.com/v1/companies/{slug}/postings`. OFFSET-paginated
(`{ content, totalFound }`). Slugs CASE-SENSITIVE. The list item has neither a description nor a
public apply URL, so `mapItem` reconstructs `applyUrl` + sets `descriptionText: ""` and
`hydrate` (the N+1 `GET .../postings/{id}`) patches them — a hydrate failure keeps the valid
un-hydrated job. Sections are concatenated in a FIXED order (stable re-ingest). NOTE: an unknown
slug returns `200 + totalFound:0` (not 404), so slug existence can't be asserted here (Phase 7).

## Deferred

Structured facets (`workplaceType`/hybrid, salary, employment type, department) are NOT promoted
to `NormalizedJob` columns — they're captured losslessly on `raw` and promoted later (Phase 9/10,
eval-driven). EU Lever, `source_runs` health tracking, and Lever offset pagination are deferred
(see `research/specs/IMPLEMENTATION_PLAN_TENATIVE.md`).
