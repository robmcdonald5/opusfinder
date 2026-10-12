# @opusfinder/scrapers

The Cloudflare **Workers** scraper runtime (Phase 8). Two cron-scheduled handlers run against Neon —
**ingestion** (frequent) and **discovery** (weekly) — instead of the dev machine. The Worker is a thin
dispatch shell; the real work lives in the already-Worker-forward libraries it calls.

## How it works

`src/index.ts` exports a `scheduled(controller, env, ctx)` handler that switches on `controller.cron`:

| Cron (UTC)    | Handler   | Calls                                              |
| ------------- | --------- | -------------------------------------------------- |
| `0 */2 * * *` | ingestion | `runIngestion(db, …)` from `@opusfinder/sources`   |
| `0 3 * * SUN` | discovery | `runDiscovery(db, …)` from `@opusfinder/discovery` |

> **Ingestion runs every 2 hours** (`0 */2 * * *`, 250 boards per tick) — the liveness driver for the
> health checker + watchdog heartbeat. It was `*/30`, then hourly × 150 boards (Phase F6); 2-hourly × 250
> halves Neon's wake-ups (each costs the tick plus a 5-min autosuspend tail) while re-fetching each board
> nearly as often — the sizing is in `wrangler.toml`. **Discovery is RESUMED, weekly**
> (`0 3 * * SUN`) as of Phase F5 (Workers Paid is now active). The Worker calls
> `runDiscovery({ workerOnly: true })`, so only `workerSafe` lanes (`outscal` + `hn`) run; a future
> Node-only lane (F5-LANES-2) is filtered out. See "Pause / resume the schedule" below for the toggle.

Each handler builds `createDb(env.DATABASE_URL)` (the neon-http client — fetch-only, no `process.env`)
and the library it calls owns its own `source_runs` row (`startRun`/`finishRun`).

> **Worker-isolation invariant (Phase 9.5 + 10 + 11).** `@opusfinder/auth` (Better Auth) and the neon-serverless
> `createAuthDb` (`@opusfinder/db/auth-client`) crash at import under `nodejs_compat` (#6665) and must
> **never** enter this bundle — the Worker reads and writes only `companies`, `jobs` and `source_runs`,
> never a user, auth or digest table. `pnpm guard:worker`
> (`scripts/check-worker-isolation.mjs`) asserts it (source scan + dependency scan) and fails CI on a leak.
> As of **Phase 10** the deny list also covers the digest pipeline's server-only stack —
> `@opusfinder/inngest` / `inngest` / `@opusfinder/llm` / `@opusfinder/rerank` / `@anthropic-ai/sdk` —
> keeping the Inngest-hosted digest generation out of this bundle. **Phase 11** adds `@opusfinder/email`
> + the `resend` SDK (email delivery is a trusted Node/server-runtime concern — like Better Auth and
> Inngest before it — never in the Worker).

- **Ingestion is chunked** (Option-A chunked cron): each tick processes the next `INGEST_LIMIT` boards
  using an id-keyset cursor stored in the `INGEST_CURSOR` KV namespace; the corpus drains across ticks.
  Boards run one at a time; politeness starts a board ≥ 500 ms after the previous board of its source
  (its adapter's `pacingKey`) finished, sleeping only the remainder, so alternating sources can't burst
  one host. A posting whose detail fetch failed is kept as stored, never overwritten (`hydrateSkipped`
  in `pnpm runs`). Inline embedding is **not wired**, and no flag turns it on: the embeddings package
  loads its env from disk at import, which crashes a Worker at module load and which `pnpm guard:worker`
  keeps out of this bundle. Jobs are upserted regardless; the still-NULL vectors are filled by
  `pnpm embeddings:backfill`.
- **Discovery** runs `runDiscovery({ ..., workerOnly: true })` bounded by `limit`/`reprobeLimit`.
  `workerOnly` restricts the run to fetch-only `workerSafe` lanes (the F5-LANES-2 guard that keeps a
  future Node-only lane out of the isolate).

> **Health & liveness (Phase F6).** On each successful ingestion tick the Worker fires a content-free
> heartbeat to an external watchdog (`env.HEALTH_PING_URL`, an optional `wrangler secret`); the watchdog
> emails the owner if the pings STOP — the only way to catch the cron's own death (a dead cron emits
> nothing). A tick that throws, or that ingests no board while at least one fails, posts its cause to the
> check's `/fail` instead, which alerts at once. Discovery heartbeats only to its own weekly check
> (`HEALTH_PING_URL_DISCOVER`, optional); without one, a failed discovery tick posts to the ingest check's
> `/fail`. A ping the watchdog doesn't answer with `OK` logs a `watchdog … not taken` / `not sent` warning.
> The rich in-DB signals (staleness, backlogs, digest/bounce health, cost) are computed
> separately by `pnpm health` (the `@opusfinder/db` checker). See `research/specs/PHASE_F6_PLAN.md`.

> **Control plane, in shadow.** Each tick reads its stage's gate from the `opusfinder-control` Worker
> over the `CONTROL` service binding, logs what it says (`control gate ingest: on (shadow: not enforced)`
> or `… would skip: …`), runs exactly as before, and writes one ledger row at the end (`src/control.ts`;
> `apps/control/README.md` "Runtimes wired"). A control-plane failure is logged, never fatal. When the
> registry gains a unit this Worker sends, deploy the control Worker first.

> **Cron weekday footgun:** Cloudflare numbers weekdays `1=Sun…7=Sat` (Quartz-style), so Sunday is
> `SUN` (or `1`), **never `0`**. The cron strings in `wrangler.toml` and the `case` literals in
> `src/index.ts` must match character-for-character: otherwise that lane never runs, and the string
> Cloudflare fires instead fails every tick with `Unhandled cron`.

## Local development (no deploy)

```bash
pnpm --filter @opusfinder/scrapers typecheck
pnpm --filter @opusfinder/scrapers exec wrangler deploy --dry-run --outdir dist   # bundle-only gate

# Run the scheduled handlers locally against real Neon (needs .dev.vars — see below):
pnpm --filter @opusfinder/scrapers dev
# In another terminal, trigger a cron via the canonical local endpoint (spaces -> + in the query):
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*/2+*+*+*"  # ingestion (every 2 h)
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+3+*+*+SUN"    # discovery
```

`wrangler dev`'s `fetch` calls hit real remote servers (Neon HTTP + the ATS APIs are real even in local
mode), so a local trigger writes a real `source_runs` row to Neon.

### Secrets / config

Copy `.dev.vars.example` → `.dev.vars` (gitignored) and fill in `DATABASE_URL` — that is all the Worker
needs. `worker-configuration.d.ts` holds only the Workers runtime types; regenerate it with
`pnpm --filter @opusfinder/scrapers types:generate` when `compatibility_date` changes. Bindings and vars
are typed by the `Env` interface in `src/index.ts`: update it whenever `wrangler.toml` adds or changes one.

## Deploy (USER actions — the agent cannot do these)

These require the Cloudflare account / real secrets / billing:

```bash
wrangler login
wrangler secret put HEALTH_PING_URL           # Phase F6 liveness heartbeat — the watchdog ping URL (optional)
wrangler secret put HEALTH_PING_URL_DISCOVER  # discovery's own weekly check: period 7 d, grace ~6 h (optional)
pnpm --filter @opusfinder/scrapers run deploy # registers/updates the Worker + applies the current [triggers]
pnpm --filter @opusfinder/db run worker-role:setup  # once: DATABASE_URL, the Worker's own database login (below)
wrangler tail opusfinder-scrapers             # stream live cron invocations
```

- **The Worker's `DATABASE_URL` is its own limited login, not yours.** With your owner `DATABASE_URL`
  exported (`packages/db/README.md` "Environment"), `worker-role:setup` creates the `scrapers_worker` role
  (SELECT/INSERT/UPDATE on `companies`, `jobs` and `source_runs` only: `packages/db/src/roles.ts`) or rotates
  its password, then pipes its connection string into this Worker's `DATABASE_URL` on stdin; it applies at
  once. Run it while no tick is running (not the first ~15 min of an even UTC hour, nor Sunday 03:00 UTC):
  the old password stops working immediately. To go back to your owner login, with it exported:
  `printf %s "$DATABASE_URL" | pnpm --filter @opusfinder/scrapers exec wrangler secret put DATABASE_URL`.
- **A migration that adds a table or sequence the Worker uses** (add it to `SCRAPERS_WORKER` in
  `packages/db/src/roles.ts`) ships as ONE chain, or every tick fails with `permission denied`:
  `pnpm db:migrate && pnpm --filter @opusfinder/db run worker-role:setup && pnpm --filter @opusfinder/scrapers run deploy`.
- **Workers Paid is required** (active): the Free plan caps an invocation at 50 subrequests, far below
  an ingestion tick (~1,500; see `[limits]` in `wrangler.toml`) or a discovery run.
- **When the ingestion cadence changes, retune the external watchdog in the SAME deploy window.** The
  heartbeat (`HEALTH_PING_URL`) pings once per successful ingestion tick, so the watchdog check's period
  must equal the cron period. For the current `0 */2 * * *`, set the healthchecks.io check to **period
  2 h, grace ~1 h** — the grace covers a tick's run time (≤ ~10 min) plus cron jitter yet stays under one
  period, so a single missed tick alerts within ~3 h. Do it BEFORE `pnpm --filter @opusfinder/scrapers run
  deploy`: an hourly-period check would page on every healthy 2-hour gap. (If `HEALTH_INGEST_MAX_AGE_H` is
  set anywhere — `packages/db/.env`, Vercel — make it 5 or unset it; the code default is 5.)
- **After any `[triggers]` change (a new cron string, a pause or a resume), confirm what actually fires.**
  The deploy output and the deployed schedules (`wrangler deployments list`, the dashboard Triggers page)
  are not proof: on 2026-10-05 they showed the new `0 */2 * * *` while Cloudflare kept firing the replaced
  `0 * * * *` for ~18 h, and every tick failed with `Unhandled cron`. Check the cron string of the next
  runs (the Worker's Cron Events, or `workersInvocationsScheduled` analytics). If the old string still
  fires, run `pnpm --filter @opusfinder/scrapers exec wrangler triggers deploy` and check again.

## Pause / resume the schedule

As of Phase F6 the **ingestion** cron is **active** (every 2 h since 2026-10; hourly before); as of
Phase F5 **discovery** is **active** weekly on Sunday (`0 3 * * SUN`, Workers Paid). Both live in
`wrangler.toml` under `[triggers]`. An idle/paused Worker costs nothing and never touches Neon — it only does anything when a cron fires. A
change to the toggle takes effect on the **next deploy**:

- **Pause** (stop all scheduled runs): set `crons = []`, then
  `pnpm --filter @opusfinder/scrapers run deploy`. Deploying with `crons = []` is the documented way to
  _remove_ the deployed triggers. (Omitting `[triggers]` entirely would instead _leave_ them untouched,
  so always set the empty array — don't just delete the block.)
- **Resume**: restore the cron array in `wrangler.toml` in place of `crons = []`, then
  `pnpm --filter @opusfinder/scrapers run deploy`.

The Worker code, secret, and KV binding are untouched by the toggle, so resuming is a one-step redeploy.
Verify either way by what fires, not by the deployed schedules (see "Deploy" above). Pause the watchdog
checks in the same window as a pause, and resume them with the crons: with no ticks, the ingest check
pages within ~3 h.

## Scaling note

Cursor-chunked single cron is the v1 fan-out (no Cloudflare Queues). If active board count and freshness
needs outgrow a chunked tick, the upgrade path is a producer/consumer Queue — see
`research/specs/PHASE_8_PLAN.md` §2.2 for the trigger.
