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
   `remoteCountries[]`, `areas[]` (world regions and blocs, by name) and a `confidence`. Low effort,
   thinking off.
2. **Check** (`src/check.ts`): every named place must exist in `places`. The country by ISO code; the region
   by code or name within it; the city by name or ASCII name (else alternate name) within the region, or
   within the country when no region was given or it isn't a GeoNames region name. A region GeoNames knows
   that holds no such city fails (a wrong state). Same-named cities in one scope: the larger wins. A place
   that fails is dropped and kept on the row's `unmatched` list, with the country and region codes that did
   check (the location rule still counts a dropped city in the user's region). Each area on the fixed list
   (`src/areas.ts`: UN M49 regions plus explicitly defined blocs such as EMEA, APAC, CIS, DACH) is expanded
   into its countries among the remote countries; an area off the list is kept as `unmatched`, and the rule
   treats its string as unresolved.
3. **Store** (`src/resolve.ts`): one row per `(company_id, raw)` with the place ids, remote countries,
   confidence, reason and `PROMPT_VERSION`. A deterministic outcome with no usable answer (a refusal, a
   reply cut off or off-schema, the provider rejecting the request's content) is stored with `confidence`
   NULL: `locations:report` lists it and only the backfill asks again. A transient failure (timeout, rate
   limit, server or network error) stores nothing, so the next run asks again. Strings over
   `MAX_LOCATION_RAW_BYTES` (2,000) are never sent; the report counts them.

The model is reached through a narrow seam (`LocationModel`: `generate`, and a batch as `submitBatch` +
`collectBatch`), built by `createLocationModel()` in `src/transport.ts` over `@opusfinder/llm`'s
transport, which also sorts provider errors into deterministic and transient. Both paths send the request
`buildLocationRequest` builds, so the daily path and the backfill can't drift apart.

The daily path gives each request a ~60 s deadline and stores each answer as it comes back. A pair that
fails transiently is skipped for the rest of the run; a call fails only when every one of its requests
(at least three) failed transiently, i.e. the provider is down.

## Commands

| Command                                          | Does                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `pnpm locations:sync`                            | The digest's daily step by hand: resolve every active pair with no row, a few requests at a time                      |
| `pnpm locations:backfill [-- --dry-run]`         | Provider batches over every pair with no row, a row from another prompt version, or no answer                         |
| `pnpm locations:backfill -- --collect <id>`      | Store a batch an earlier backfill submitted (its id is printed at submit), without sending anything                   |
| `pnpm locations:report [-- --limit 25]`          | On-site coverage by source; worklists by active-job count (no usable place, low confidence, failed check, no answer)  |
| `pnpm locations:explain -- --email … --job <id>` | Each of the job's strings: places, confidence, reason, version, miles from home; the rule case + verdict; cosine rank |
| `pnpm locations:explain -- --email …`            | The user's top candidates after the location filter, with place + distance (`--all`: every approved user)             |

The digest orchestrator runs the daily step itself before its fan-out (see `@opusfinder/inngest`). All of
them need `DATABASE_URL`; sync and backfill also need `OPENROUTER_API_KEY` (`packages/llm/.env`) and write
`location_strings` (owner-run). The backfill submits batches of up to 1,500 requests at once and stores
each as it ends (minutes to hours); a batch that fails to submit or to end costs only its own pairs, and
one whose wait failed can be stored later with `--collect`. `--recency-days N` on explain overrides the
user's recency window for a preview.

## Changing the prompt

Bump `PROMPT_VERSION` with any change to the prompt, the user message or the schema, run
`pnpm eval:locations` (it must not get worse), then `pnpm locations:backfill` re-resolves the older rows as
one batch. Stored rows are the source of truth between versions: a model answer isn't a pure function, so
nothing re-resolves a row without a version change.
