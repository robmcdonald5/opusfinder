# @opusfinder/discovery

Slug-discovery pipeline (Phase 7): companies populate themselves from upstream sources instead of
being hand-seeded. It pulls company/ATS pairs from a registry of **seed lanes** (`SEED_LANES`) — the
SHA-pinned outscal/OpenJobs list (`outscal`) plus the monthly Hacker News "Who is hiring?" thread via
Algolia (`hn`, Phase F5) — cross-lane-deduped, then runs the existing spine: HTTP-probe each candidate
against its ATS endpoint **by reusing the Phase-6 `SourceAdapter` request-builders** in
`@opusfinder/sources`, idempotently upsert the live subset into `companies`, and deactivate slugs after
30 days of consecutive failed probes. Every run is tracked in `source_runs`. `pnpm discover` runs it
locally; the Phase-8 Worker's weekly cron (`0 3 * * SUN`, resumed Phase F5) calls the same
`runDiscovery(db, opts)` directly with `{ workerOnly: true }` so only `workerSafe` lanes run in the
isolate (`runDiscovery` is argv-free for that).

## Pipeline

`runDiscovery(db, opts)` is a linear, source-agnostic flow under one `source_runs` row:

1. **Seed** (lane registry) — `selectLanes(SEED_LANES, opts)` picks the lanes to run (all by default;
   `opts.lanes` restricts by name, `opts.workerOnly` keeps only `workerSafe` lanes), then `resolveLanes`
   fetches each: `outscal` = `loadSeed()` (SHA-pinned `data/companies_v2.json` from outscal/OpenJobs,
   `SEED_URL`/`SEED_SHA`, for deterministic runs); `hn` = `fetchHnAlgoliaLane` (`lanes/hn.ts`). A
   `failLoud` lane (outscal) re-throws on fetch failure (run-fatal); an isolated lane (hn) tallies
   `lane_<name>_error` and continues. Counts accumulate field-wise; candidates are cross-lane-deduped
   by `(source, slug)`; the per-lane `lane_<name>_candidates` / `lane_<name>_error` ride
   `source_runs.counts`. (`loadSeed` / `SEED_URL` / `SEED_SHA` are unchanged — the outscal upstream has
   been static since 2026-04-22 with no bump, so "SHA-pinned" stays accurate for the outscal lane.)
2. **Resolve** (`resolve.ts`) — `resolveSeed()` turns each record's `ats_links[]` into deduped
   `Candidate`s. `resolveUrl()` walks `SOURCE_NAMES` and the first adapter whose `matchUrl` claims the
   URL wins (hosts are disjoint). Drops are tallied: `badUrl` (unparseable), `deferredNoAdapter` (an
   unsupported ATS or a vanity careers page), `invalidSlug` (fails the universal floor).
3. **Partition** — each candidate is NEW, KNOWN-ACTIVE, or KNOWN-INACTIVE (via `listCompanyStates`,
   which returns `active`). **NEW + KNOWN-INACTIVE go to the probe path** (so a re-discovered
   dead-then-revived slug can reactivate); KNOWN-ACTIVE rows are left to the reprobe pass.
4. **Probe + classify** (`probe.ts`) — `probeCandidates` reuses `adapters[source].jobsRequest(ctx,
null)` through a NON-throwing, per-host-throttled fetcher (a 404/400/200-empty is the signal, not an
   error). Each response is classified by `adapters[source].classifyProbe?` or the status-first
   `defaultClassify` → `live` / `live-empty` / `absent` / `indeterminate`.
5. **Act** — `live`/`live-empty` ⇒ `upsertCompany` + `markProbeResult(live=true)`; `absent` ⇒ dropped;
   `indeterminate` / transient (network-exhausted) ⇒ left for a later run.
6. **Reprobe** — `listCompaniesForReprobe` re-checks the oldest-probed ACTIVE companies; live refreshes
   them, a confirmed `absent` increments the failure streak (`markProbeResult(live=false)`).
7. **Sweep** — `deactivateStale(30)` flips `active=false` for any row failing past the window, and (Phase F2,
   Arm B) bulk-closes those just-deactivated boards' still-active jobs via `closeJobsForCompanies` — the orphan
   class the ingest-time feed-absence sweep is blind to, since a deactivated board is never re-fetched.
   `deactivateStale` was widened to RETURN the deactivated company ids; the close is tallied onto the run's
   `source_runs.counts` (`jobsClosedOnDeactivation` / `wouldCloseOnDeactivation`). Shipped SHADOW (count-only);
   enforcement rides the single `LIFECYCLE_CLOSE_ENFORCE` switch via `runDiscovery`'s `enforceLifecycle` option (the Worker
   sets it from `parseEnforceFlag(env.LIFECYCLE_CLOSE_ENFORCE)`, the same flag that flips Arm A + Arm C).

## Usage

```sh
pnpm discover                       # BROADER pass: all covered sources, every resolved candidate
pnpm discover --source=greenhouse   # scope to one source
pnpm discover --lanes=outscal,hn    # restrict to named lanes (omit = all; rejects an empty value)
pnpm discover --limit=50            # cap the NEW/INACTIVE probe worklist
pnpm discover --dry-run             # read-only PREVIEW: probe + tally, write nothing
```

Defaults: no `--limit` (probe every candidate), per-host `≤3` concurrent + `≥400ms` spacing (so the
shared API hosts — all greenhouse boards hit `boards-api.greenhouse.io` — aren't hammered while unique
subdomain tenants run in parallel), global concurrency `12`, reprobe limit `500`, 30-day staleness
window. The live pinned seed (the `outscal` lane only) resolves to **~1,677 candidates across 8
sources**; the `hn` lane adds the current month's covered boards on top (a recent live harvest yielded
72 boards), cross-deduped against outscal by `(source, slug)`.

## Staleness model

`active` flips false after ~30 days of CONSECUTIVE failed probes. The clock is
`COALESCE(last_live_at, created_at)`: a row decays from its last confirmed-live probe, or — for a
company seeded by ingestion that a discovery LIVE probe has never refreshed — from when it was created,
so it gets the full window instead of dying on its first failed probe. Deactivation is gated on a
non-zero failure streak, so a never-failed row is never swept and SmartRecruiters' unassertable `200`
(which never increments the streak) can't drift a healthy company. One LIVE probe resets the streak,
refreshes `last_live_at`, and re-activates — so a revived slug un-deactivates itself.

> The staleness sweep follows the run's scope: a `--source=X` run only deactivates stale rows of X
> (it won't touch a source it never re-probed this run), and the broader default pass (no `--source`)
> sweeps every source.

## Coverage caveats

- **SmartRecruiters live-empty boards are invisible** — `200 + totalFound:0` is unassertable
  (`indeterminate`), so an SR company with zero current openings only enters `companies` once it posts
  a job (and has nothing to digest until then anyway).
- **Gem contributes zero seed rows** (absent from outscal). It ships `matchUrl` for exhaustiveness; a
  Wave-B seed (e.g. `Masterjx9/OpenPostings`) bootstraps it later. Pinpoint + Trakstar DO appear.
- **EU Lever** (`jobs.eu.lever.co`) returns `null` from `matchUrl` — never a candidate; real EU support
  is deferred to Phase 8.
- **Unknown-slug 404 signals** for Greenhouse/Lever/Ashby/Workable were inferred, not documented;
  Greenhouse's `404` is now confirmed live. The status-first default + `locate`-in-try/catch contains
  any surprise to `indeterminate` (no write) until a one-line `classifyProbe` override is added.
- **HN encodes `/` as `&#x2F;`**, so the `hn` lane entity-decodes via the shared
  `cleanHtml(text, ["decode"])` (from `@opusfinder/sources`) before URL extraction; only covered-ATS
  URLs an adapter's `matchUrl` claims are kept.

## Deferred (**F5-LANES-2** / later passes)

Passive DNS (RapidDNS) for subdomain tenants and Common Crawl URL mining are deferred to
**F5-LANES-2** (both Node-only — `workerSafe: false`), along with the Wave-B seed and an optional
`probeRequest?` descriptor member to drop hydration params on the bulk pass. (HN "Who is hiring?" /
Algolia shipped in Phase F5 as the `hn` lane.)

## Tests

All suites are co-located `*.test.ts` (Vitest `unit` project), run from the repo root (PowerShell):

```powershell
pnpm exec vitest run packages/discovery     # this package: selectLanes/resolveLanes, resolveUrl/resolveSeed,
                                            # probeFetch/probeCandidate(s), HostThrottle, parseHnThread (all offline)

# Opt-in live gates (real network, skipped unless the flag is set):
$env:HN_LIVE_TEST="1";      pnpm exec vitest run packages/discovery/src/lanes/hn.test.ts   # hits real HN Algolia
$env:OUTSCAL_SEED_LIVE="1"; pnpm exec vitest run packages/discovery/src/resolve.test.ts    # resolves the real pinned seed
```
