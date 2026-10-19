# @opusfinder/locations

The location normalizer: turns each company's raw location strings ("Columbus, OH", "US-CA-Menlo Park",
"Remote within Canada or United States", a bare "Dublin") into GeoNames places, once, and stores the
answer in `location_strings`. The digest's location rule (`@opusfinder/db` `repos/location-rule.ts`) reads
those rows; nothing here runs at retrieval time.

## How a string is resolved

1. **Request** (`src/model.ts`, `src/prompt.ts`): one stable system block (rules + worked examples drawn
   from real strings; cacheable) and a per-pair user message: the company's slug and ATS, up to 20 of its
   other location strings as context (most-listed first), and the string itself. Structured output
   (`src/schema.ts`): a one-line `reason` first, then `places[]` (`{city, region, country, kind}`),
   `remoteCountries[]` and a `confidence`. Low effort, thinking off.
2. **Check** (`src/check.ts`): every named place must exist in `places`. The country by ISO code; the region
   by code or name within it; the city by name or ASCII name (else alternate name) within the region, or
   within the country when no region was given or it isn't a GeoNames region name. A region GeoNames knows
   that holds no such city fails (a wrong state). Same-named cities in one scope: the larger wins. A place
   that fails is dropped and kept on the row's `unmatched` list.
3. **Store** (`src/resolve.ts`): one row per `(company_id, raw)` with the place ids, remote countries,
   confidence, reason and `PROMPT_VERSION`. A reply with no usable answer (refused, cut off, off-schema) is
   stored with `confidence` NULL; a request that never completed gets no row and is retried later.

The model is reached through a narrow seam (`LocationModel`: one `generate`, one `batch`), built by
`createLocationModel()` in `src/transport.ts` over `@opusfinder/llm`'s transport. Both paths send the
request `buildLocationRequest` builds, so the daily path and the backfill can't drift apart.

## Commands

| Command                                         | Does                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm locations:sync`                           | The digest's daily step by hand: resolve every active pair with no row, a few requests at a time                       |
| `pnpm locations:backfill [-- --dry-run]`        | One provider batch over every pair with no row, a row from another prompt version, or no answer                        |
| `pnpm locations:report [-- --limit 25]`         | On-site coverage by source; worklists by active-job count (no usable place, low confidence, failed check, no answer)   |
| `pnpm locations:explain -- --email … --job <id>` | Each of the job's strings: places, confidence, reason, version, miles from home; the rule case + verdict; cosine rank |
| `pnpm locations:explain -- --email …`           | The user's top candidates after the location filter, with place + distance (`--all`: every approved user)              |

The digest orchestrator runs the daily step itself before its fan-out (see `@opusfinder/inngest`). All of
them need `DATABASE_URL`; sync, backfill and explain's previews read production, and sync/backfill write
`location_strings` (owner-run). `--recency-days N` on explain overrides the user's recency window for a
preview.

## Changing the prompt

Bump `PROMPT_VERSION` with any change to the prompt, the user message or the schema, run
`pnpm eval:locations` (it must not get worse), then `pnpm locations:backfill` re-resolves the older rows as
one batch. Stored rows are the source of truth between versions: a model answer isn't a pure function, so
nothing re-resolves a row without a version change.
