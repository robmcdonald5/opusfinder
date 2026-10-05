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
  per-board accounting. Returns `NormalizedJob[]` (no source `raw` on them — `jobs.raw` isn't stored;
  a `hydrate` gets its list item as an argument instead).
- **`SourceAdapter` descriptors (`src/adapters/{greenhouse,lever,ashby,workable,smartrecruiters,recruitee,pinpoint,gem,trakstar}.ts`)**
  — per-source data: `source`, `normalizeSlug`, `jobsRequest`, `locate`, `mapItem`, the Phase-7
  discovery pair `matchUrl` (REQUIRED — the URL→raw-slug inverse of `jobsRequest`; must not throw;
  parses the board/API host only) and the optional `classifyProbe` (probe response → `ProbeOutcome`;
  overridden only on SmartRecruiters + Trakstar), plus the optional `nextCursor` (pagination) /
  `hydrate` (a second fetch). `mapItem` is a typed function per source — never declarative config.
  See `src/adapters/types.ts`.
- **`cleanHtml(input, steps)` (`src/adapters/text.ts`)** — the shared HTML→text primitive. The
  decode/strip/collapse atoms are invariant; only their ORDER varies per source, so it takes
  an ordered step list (e.g. Greenhouse's asymmetric double-encoding needs
  `["decode","strip","decode","collapse"]`). As of Phase F5 `cleanHtml`, `htmlToText`, and the
  `CleanStep` type are part of the package's **PUBLIC surface** (`src/index.ts`): the discovery
  `hn` lane reuses `cleanHtml(text, ["decode"])` to decode `&#x2F;`-encoded board URLs rather than
  hand-rolling a weaker copy.
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
- **`url-match.ts` (`src/adapters/url-match.ts`, Phase 7)** — pure WHATWG-`URL` parsing primitives
  shared by the adapters' `matchUrl` (`pathSegments` / `firstPathSegment` / `segmentAfter` /
  `subdomainLabel`; none throw). `RESERVED_SUBDOMAINS` blocks vendor infra + apply/marketing hosts
  (`www`, `api`, `apply`, `careers`, `jobs`, `talent`, `recruiting`, …) so a seed link like
  `apply.recruitee.com` (which serves a real offers board) can't mint a phantom tenant;
  `segmentAfter` anchors on the FIRST marker occurrence so a board slugged like a structural token
  (e.g. `boards`) still resolves.

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

Each board upserts via `@opusfinder/db`'s `upsertJobs` (`pnpm ingest` first get-or-creates the company
with `upsertCompany`; `ingest:all` takes the id from the `companies` row it iterates), then embeds the
new/changed postings via `@opusfinder/embeddings` (best-effort: a Voyage failure is warned, not
fatal; skipped when `VOYAGE_API_KEY` is unset or `--no-embed` is passed). `ingest:all` isolates
each board in a try/catch — one dead slug doesn't halt the run.

`ingest:all` is now a thin CLI shell over the shared `runIngestion(db, opts)` library
(`src/ingest.ts`), which the Phase-8 Worker cron also calls — the CLI commands are unchanged. Boards run
one at a time. Politeness (`paceMs`, 500 ms) is per pacing key — an adapter's `pacingKey`, default its
source, since no two adapters share a request host — and by TIME: a board starts ≥ 500 ms after its
key's previous board FINISHED, sleeping only the remainder, so alternating sources can't burst one host
and a board after enough other work waits for nothing.

**A failed hydrate never overwrites stored content** (`upsertJobs`, the single persistence choke point,
enforces it for every caller):

- **Any failed or empty detail fetch → `contentMissing`** (a timeout, 5xx/429 after retries, a `404`/`410`,
  JSON null, SmartRecruiters' `200` `{"message":"Posting not available"}`, a `jobAd` without sections):
  `runAdapter` keeps the listed job but flags it, since its description is the list item's placeholder
  `""`. Its content is never written — the stored title, description, `content_signature` and embedding stay
  as they are, and a brand-new posting waits for a run that fetches its content. Only its `company_id`
  follows the board listing it, so a posting that moved boards isn't closed by its old board's sweep. It
  still counts present (`markJobsPresent`, the absence sweep). `counts.hydrateSkipped` tallies these.
  **Known limitation (an accepted trade-off — a not-found detail isn't treated as "gone"):** a stored
  posting whose detail is `404`/`410`/"Posting not available" while the ATS still LISTS it stays `active`
  and digest-eligible (retrieved and reranked, on its last stored content) until the ATS delists it. And
  `hydrate_skip_ratio` can't tell those not-founds from 5xx/timeouts, so steady list-vs-detail lag can hold
  the ratio up while the detail endpoint is healthy. **Known follow-up:** count not-found details
  separately (a not-found counter) so the ratio tracks real failures and such postings can be held back.
- **Any source → blank description kept out**: a blank (empty/whitespace) description never replaces a
  non-blank stored one — an inline-content board (Greenhouse `content=true`, Workable `details=true`, Lever)
  momentarily serving no body, or SmartRecruiters `jobAd.sections: {}`. The stored text, its signature and
  its embedding stay; a title change in the same fetch still applies. A brand-new posting is inserted as
  given, `""` included.

`hydrateSkipped` (in `pnpm runs` and on each `ingest:all` board line) counts distinct postings on boards
whose write succeeded.

Since Phase F2, `runIngestion` also runs a per-board **feed-absence lifecycle sweep** (`sweepLifecycle`, gated
on a non-empty fetch) after each successful board: postings absent from a healthy fetch accrue a
`consecutive_absences` streak and soft-close at the threshold, reviving on reappearance — tallied onto
`IngestionCounts` (`revived` / `swept` / `closed` / `wouldClose` / `sweepFailed`) and the `logSummary` line.
Shipped SHADOW (count-only): the close is tallied as `wouldClose`, not yet written. Enforcement is the
single `LIFECYCLE_CLOSE_ENFORCE` switch — `runIngestion`'s `enforceLifecycle` option, which the Worker sets from
`parseEnforceFlag(env.LIFECYCLE_CLOSE_ENFORCE)` (the same flag flips Arm B + Arm C); set it to `enforce` once the
shadow counters are reviewed.

## Per-adapter quirks (institutional memory)

**Greenhouse** — `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`. Unpaginated
`{ jobs, meta }`. `content` is DOUBLE-entity-encoded (tags single-encoded, inner text entities
double-encoded) → decode→strip→decode→collapse. Slugs lowercase. `remote` inferred from the
location string. `postedAt` = `first_published` ‖ `updated_at`.

**Lever** — `api.lever.co/v0/postings/{slug}?mode=json`. Response is a BARE array (no envelope).
Slugs CASE-SENSITIVE (don't lowercase). `id` is a UUID string; title is on `text`; `createdAt`
is ms-epoch. Structured `workplaceType` (`remote`⇒true, `hybrid`/`onsite`⇒false). Description
from `descriptionPlain` (collapse only); the `lists[]`/`additional` sections are not mapped.
**US host only** — EU tenants (`api.eu.lever.co` / `jobs.eu.lever.co`) return `null` from `matchUrl`
and stay deferred (EU needs a per-company region channel; Phase 8).

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
paces between consecutive Workable boards.

**SmartRecruiters** — `api.smartrecruiters.com/v1/companies/{slug}/postings`. OFFSET-paginated
(`{ content, totalFound }`). Slugs CASE-SENSITIVE. The list item has neither a description nor a
public apply URL, so `mapItem` reconstructs `applyUrl` + sets `descriptionText: ""` and
`hydrate` (the N+1 `GET .../postings/{id}`) patches them. Any failed or empty detail (a `404`, `200`
`{"message":"Posting not available"}`, no `jobAd.sections`) flags the listed job `contentMissing`
(present, content not written). Sections are concatenated in a FIXED order (stable re-ingest). NOTE: an unknown slug returns
`200 + totalFound:0` (not 404), so slug existence can't be asserted here (Phase 7).

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
to `NormalizedJob` columns — the source object isn't kept (`raw` is no longer stored or carried), so
promoting one later (Phase 9/10, eval-driven) means a mapper change plus a re-ingest. EU Lever and
Lever offset pagination are deferred (see `research/specs/IMPLEMENTATION_PLAN.md`); `source_runs` run-tracking landed in Phase 7
(see `@opusfinder/db`). **Wave B ATS** — Polymer, Workday,
Eightfold, Rippling, Personio — are deferred too: each adds a new axis of variation (an N+1
hydrate, POST/page pagination, or custom career domains beyond a clean slug). Polymer
specifically needs an N+1 description hydrate **and** page pagination (a `{ kind:"page" }` member
on the `Cursor` union), so it is not a zero-hydrate Wave-A board.
