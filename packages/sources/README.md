# @opusfinder/sources

ATS adapters that fetch public job-board postings and normalize them into the
shared `NormalizedJob` shape. Phase 1 ships one concrete adapter — **Greenhouse** —
a plain fetch + normalize with no retries or queueing. As of Phase 2 the runnable
script persists its output to Neon through `@opusfinder/db`; the adapter itself
stays pure (persistence lives in `db`).

There is intentionally **no shared adapter interface or registry** yet. Greenhouse
is a plain `fetchJobs(slug)` function; the abstraction is extracted in Phase 6, once
a second/third adapter (Lever, Ashby) reveals what actually varies across sources.

## Usage

```sh
# from the repo root, after `pnpm install`:
pnpm fetch:greenhouse vercel
# equivalently:
pnpm --filter @opusfinder/sources fetch:greenhouse vercel
```

Fetches from `boards-api.greenhouse.io/v1/boards/<slug>/jobs`, then upserts the
normalized jobs into Neon via `@opusfinder/db` (`upsertCompany` + `upsertJobs`) and
prints a one-line summary — `changed` / `unchanged` counts plus any duplicate ids
collapsed within the batch. An empty board persists nothing and bails before opening
a DB connection.

After persisting, the script embeds this board's postings that still lack a vector —
freshly inserted jobs plus any whose content changed (`upsertJobs` nulls a job's embedding
when its title or description changes) — via `@opusfinder/embeddings`, logging the count
and token cost. Embedding is best-effort: a Voyage failure is caught and warned, never
failing an otherwise-successful ingest (re-run `pnpm embeddings:backfill` to retry). It is
skipped (with a notice) when `VOYAGE_API_KEY` is unset, or explicitly via
`pnpm fetch:greenhouse <slug> --no-embed`.

## Greenhouse adapter notes (institutional memory)

- **Unpaginated.** The board API returns every posting in one response
  (`{ jobs, meta }`), so `fetchJobs` is a single fetch with no cursor loop.
- **`content` is double-entity-encoded HTML.** Tags arrive as `&lt;div&gt;` and
  inner text entities as `&amp;nbsp;` / `&amp;#39;`. `descriptionText` is produced by
  decode → strip tags → decode again → collapse whitespace; stripping before decoding
  would match no real tags and ship entity soup. The original HTML stays on `raw`.
- **No structured remote flag.** `remote` is inferred from the location string
  (`/\bremote\b/i`); `"Hybrid - …"` postings intentionally resolve to `false`.
- **Slug casing.** Board tokens are lowercase, so the adapter lowercases the slug
  before `companySlug()` (which only enforces the universal floor and must not change
  casing — Phase 6 SmartRecruiters is case-sensitive). This per-source rule is what
  Phase 6 lifts onto `SourceAdapter.normalizeSlug`.
- **`postedAt`** uses `first_published`, falling back to `updated_at` (including when
  `first_published` is an empty string); an unparseable date becomes `null`.
- **Resilient mapping.** The response is untrusted `unknown`: each posting is validated
  individually, and a malformed one (non-object, or missing `id`/`title`/`absolute_url`)
  is skipped and counted — never fatal, so one bad row can't abort the whole board.
- **Defensive entity decoding.** Numeric entities that are out of range, lone surrogates,
  or C0 control chars (e.g. `&#0;`) are left as their literal text rather than crashing
  (`String.fromCodePoint` throws above `0x10FFFF`) or injecting invalid/NUL characters.
