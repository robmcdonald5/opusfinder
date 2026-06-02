# @opusfinder/sources

ATS adapters that fetch public job-board postings and normalize them into the shared
`NormalizedJob` shape, then persist them through `@opusfinder/db`. Phase 6 covers all five
Launch-5 ATS — **Greenhouse, Lever, Ashby, Workable, SmartRecruiters** — behind one shared
abstraction. Phase 6.5 Wave A adds four more zero-hydrate public boards —
**Recruitee, Pinpoint, Gem, Trakstar Hire** — each a descriptor + one `mapItem` with no change
to the shared plumbing. (Polymer was deferred to Wave B: it needs an N+1 hydrate and page
pagination, so it isn't zero-hydrate.)

## Architecture

The abstraction was **extracted** from concrete Greenhouse + Lever + SmartRecruiters adapters
(not designed up front). It has these parts:

- **`runAdapter` (`src/adapters/run-adapter.ts`)** — the invariant plumbing, identical for
  every source: slug normalization → the pagination loop (`jobsRequest` → fetch → `locate` →
  `mapItem`) → the single resilient fetch (retry + exponential backoff + `Retry-After`, with a
  non-JSON-body guard) → two-tier resilience (`locate` fails LOUD on a bad envelope; `mapItem`
  fails SOFT, skipping one bad posting) → the optional bounded-concurrency hydrate pool →
  per-board accounting. Returns `NormalizedJob[]`.
- **`SourceAdapter` descriptors (`src/adapters/{greenhouse,lever,ashby,workable,smartrecruiters,recruitee,pinpoint,gem,trakstar}.ts`)**
  — per-source data: `source`, `normalizeSlug`, `jobsRequest`, `locate`, `mapItem`, and the
  optional `nextCursor` (pagination) / `hydrate` (a second fetch). `mapItem` is a typed
  function per source — never declarative config. See `src/adapters/types.ts`.
- **`cleanHtml(input, steps)` (`src/adapters/text.ts`)** — the shared HTML→text primitive. The
  decode/strip/collapse atoms are invariant; only their ORDER varies per source, so it takes
  an ordered step list (e.g. Greenhouse's asymmetric double-encoding needs
  `["decode","strip","decode","collapse"]`).
- **`htmlToText(value)` (`src/adapters/text.ts`)** — names the most common recipe once: the
  "raw tags + single-encoded entities" cleaner (`strip → decode → collapse`) used by
  Workable/SmartRecruiters/Pinpoint/Recruitee/Trakstar and the HTML fallback of Gem/Ashby.
  Greenhouse keeps `cleanHtml(..., ["decode","strip","decode","collapse"])` directly; plain-text
  fields use `cleanHtml(..., ["collapse"])`.
- **`fields.ts` (`src/adapters/fields.ts`)** — shared `NormalizedJob` field-derivation atoms:
  `inferRemoteFromText(locations)` (the word-boundary "remote" fallback, applied only after any
  authoritative structured signal) and `joinParts(parts)` (compose one location string from
  ordered city/region/country parts). The invariant lives once; per-source variation stays in
  `mapItem`. Pure string ops — Worker-safe (Phase 8).

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
pnpm ingest recruitee xite
pnpm ingest pinpoint workwithus
pnpm ingest gem gem
pnpm ingest trakstar instacart
#   <source> ∈ greenhouse | lever | ashby | workable | smartrecruiters | recruitee | pinpoint | gem | trakstar
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

### Phase 6.5 Wave A (zero-hydrate public boards)

**Recruitee** — `{slug}.recruitee.com/api/offers/`. Unpaginated `{ offers }`. Slugs lowercase
(host case-insensitive). `id` is NUMERIC (stringified before `jobId`). `remote` is THREE
independent booleans `remote`/`hybrid`/`on_site` that CO-OCCUR (`remote:true` ships with
`hybrid:true`), so `hybrid` is checked FIRST → Hybrid ⇒ false. Locations prefer the multi-office
`locations[].name` over the primary-only top-level `location`. `published_at` is
`"YYYY-MM-DD HH:MM:SS UTC"` (NOT ISO) → massaged to ISO for engine-independent parsing
(Worker-forward). `applyUrl` = `careers_apply_url` ‖ `careers_url` VERBATIM (custom careers
domains exist — never reconstruct). Unknown slug ⇒ 404 (assertable, Phase 7).

**Pinpoint** — `{slug}.pinpointhq.com/postings.json`. Unpaginated `{ data }` (the `?page` param
is silently IGNORED). Slugs lowercase. Posting `id` (string) is DISTINCT from the nested
`job.id` and the url UUID. Locations compose `location.city` + `province` — NOT `location.name`
(an office label, sometimes the literal "Remote" trap). `remote` from the `workplace_type` enum.
`description` is single-encoded HTML (`<!--block-->` markers removed by the tag regex). NO posted
date (only `deadline_at`, an application-CLOSE date) ⇒ `postedAt` null. Unknown slug ⇒ 404;
real-but-empty ⇒ `200 {data:[]}`.

**Gem** — `api.gem.com/job_board/v0/{slug}/job_posts/` (**trailing slash required**). BARE
top-level array (like Lever) — `locate` throws if not an array. Slugs CASE-SENSITIVE (an
uppercased slug 404s). `id` is already a string (legacy numeric-strings + opaque tokens).
`remote` from the `location_type` enum (remote/hybrid/in_office; no isRemote trap). Description
prefers the genuine plain-text `content_plain` (collapse only), falling back to single-encoded
HTML `content` only when empty. `postedAt` = `first_published_at` (ISO). Unknown slug ⇒ 404;
real-but-empty ⇒ `200 []`.

**Trakstar Hire (Recruiterbox)** — `jsapi.recruiterbox.com/v1/openings/?client_name={slug}`.
OFFSET-paginated `{ meta:{total}, objects }` — reuses the existing `{ kind:"offset" }` Cursor
(`PAGE_LIMIT=20`), `nextCursor` mirrors the SmartRecruiters defensive shape. Slugs lowercase
(host echoes `client_name` lowercased). `id` is a string. `location` is a single OBJECT
(compose city/state/country). `remote` from `allows_remote` (true/false both authoritative; only
null infers from text — no "Hybrid" value). `description` single-encoded HTML, may be `""`. NO posted date
(`close_date` is an expiry) ⇒ `postedAt` null. `applyUrl` = `hosted_url` (canonical reconstruct
fallback). Unknown slug ⇒ 400; real-but-empty ⇒ `200 meta.total:0`.

## Deferred

Structured facets (`workplaceType`/hybrid, salary, employment type, department) are NOT promoted
to `NormalizedJob` columns — they're captured losslessly on `raw` and promoted later (Phase 9/10,
eval-driven). EU Lever, `source_runs` health tracking, and Lever offset pagination are deferred
(see `research/specs/IMPLEMENTATION_PLAN_TENATIVE.md`). **Wave B ATS** — Polymer, Workday,
Eightfold, Rippling, Personio — are deferred too: each adds a new axis of variation (an N+1
hydrate, POST/page pagination, or custom career domains beyond a clean slug). Polymer
specifically needs an N+1 description hydrate **and** page pagination (a `{ kind:"page" }` member
on the `Cursor` union), so it is not a zero-hydrate Wave-A board.
