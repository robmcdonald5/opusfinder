# @opusfinder/inngest

The per-user digest pipeline on **Inngest** — the durable orchestration that turns a user
profile + the live job corpus into ranked `digests` / `digest_items` rows with per-job reasons, then
emails them (Phase 11). The sequence is: deterministic filter → pgvector retrieval (top ~50 vs
`user_profiles.embedding`) → **synchronous** Haiku rerank (prompt-cached) → **batched** Sonnet
synthesis (Anthropic Message Batches API) → persist → **send (Resend, idempotency-keyed) → bounded
delivery poll → record** (`src/delivery.ts`).

> **Phases 10/11 run on the local Inngest dev server** (`npx inngest-cli dev`, `INNGEST_DEV=1`) for
> end-to-end iteration — keyless, no Cloud account needed. **Phase 12a then BUILT the production runtime:**
> the cadence cron (`makeCadenceOrchestrator`), the F8 backfill drain, and the deployed serve home
> (SvelteKit-on-Vercel via `inngest/sveltekit` at `apps/web/src/routes/api/inngest/+server.ts`) all shipped
> on `main` (PR #24) and are **DEPLOYED LIVE on Vercel + Inngest Cloud** (2026-06-17) — the SvelteKit serve
> hosts the digest fns + the cadence cron + the F8 `embed-backlog-drain`, with
> `INNGEST_SIGNING_KEY`/`INNGEST_EVENT_KEY` auto-provisioned by the Inngest↔Vercel integration. Delivery
> webhooks + the unsubscribe endpoint remain **12b**.

> **Worker invariant.** Inngest functions are a Node/server runtime that read Neon directly as a
> trusted process — this package must NEVER enter the `apps/scrapers` Cloudflare Worker bundle. Both
> `@opusfinder/inngest` and `inngest` are on `pnpm guard:worker`'s deny lists.

## Why Inngest (and the local-dev-first path)

The synthesis step submits an Anthropic **Message Batch** (50% discount) and then waits for it — most
batches finish in under an hour but the SLA is a 24h hard cap. Inngest's durable `step.sleep` /
`step.run` suspend across that wait at **zero compute cost**, which a vanilla Cloudflare cron tick
cannot (hard 15-min wall, no cross-invocation suspend). That durability is the decisive reason the
digest runs on Inngest rather than extending `apps/scrapers`. Phase 10 only needs the local dev server
to prove the pipeline end-to-end; Phase 12a then built the deployed runtime (the SvelteKit serve route +
the cadence cron + the F8 backfill), shipped on `main` (PR #24) and DEPLOYED LIVE on Vercel + Inngest Cloud
(2026-06-17) with `INNGEST_SIGNING_KEY`/`INNGEST_EVENT_KEY` auto-provisioned by the Inngest↔Vercel
integration (email ships in Phase 11 on the local dev runtime — locked at Phase-11 planning, 2026-06-11).

## What's here

- `src/inngest.ts` — the `inngest` client (`id: "opusfinder"`) + the typed event surface
  (`EventSchemas().fromRecord`): `digest/run.requested` (kicks the orchestrator — fired by the manual CLI
  AND by the 12a cadence cron, which carries `trigger:'cron'`; optional `userId` scopes it to one user)
  and `digest/user.requested` (one per recipient, fanned out by the orchestrator).
- `src/digest.ts` — `createDigestFunctions(deps)` → `[orchestrator, perUser, cadence]`, plus the `DigestDeps`
  injection seam (`db` + a `rerank` closure + the `batch` submit/poll/collect lifecycle + the Phase-11
  `email` send/lastEvent pair) so the pipeline is stub-testable and the heavy `@opusfinder/llm` wiring
  stays out of the function bodies.
  - **Orchestrator** (`digest-orchestrator`): opens a `digest_run`, resolves recipients (single user
    when `event.data.userId` is set — runtime-validated as a uuid, since the event schema is
    compile-time only — else every eligible user keyset-swept, with `cadenceDue` passed through as
    `event.data.trigger === 'cron'` so a cron run filters to cadence-due users while a manual `--all`
    sweep does not), fans out one `digest/user.requested`
    each via `step.sendEvent`, and finalizes the run to the dispatch count. Fan-out is fire-and-forget,
    so the run row records **dispatch**, not per-user completion (those land on `digests`). A step that
    exhausts its retries is caught and terminalized onto the run row (`status: 'error'` +
    `error_sample`) before the failure is rethrown.
  - **Cadence** (`makeCadenceOrchestrator`, `{ cron: "0 13 * * *", singleton: { mode: "skip" } }`): the
    Phase-12a daily tick. It just emits `digest/run.requested` with `{ trigger: 'cron' }` (reusing the
    orchestrator above rather than a parallel pipeline), so `listDigestRecipients`'s opt-in `cadenceDue`
    predicate (daily 20h / weekly 6d / monthly 28d off `last_digest_sent_at`) decides who is actually due
    on each daily run. Manual `pnpm digest --all` is unaffected (no `cadenceDue`).
  - **Per-user** (`digest-user`, `singleton` keyed on `userId`, mode `skip` — `concurrency` would
    release its slot during the batch-wait sleeps and let runs overlap): load + **eligibility gate**
    (skip if no profile/embedding, unverified email, `!digestEnabled`, or suppressed — so even a manual
    single-user trigger respects an opt-out and matches the `--all` sweep's gate) → retrieve (geo +
    exclusion keywords applied inside retrieval's post-filter — Phase-F3 merges `dealbreakers` into that
    exclusions filter, and `locationMode` replaces the old `remoteOk` boolean — plus the Phase-F1 repost
    anti-join — `excludeSignatures` from `alreadyShownSignatures`, threaded alongside the id anti-join — and a
    same-signature display-collapse, all before its over-fetch trim) → sync
    rerank (top-K, with the prompt-cache counters for the gate) — Phase-F3 applies a `MIN_SCORE=0.5`
    quality floor that drops sub-floor reranked items BEFORE the top-K cut (a short/empty digest over
    padding with weak fits), with a no-send skip (`'no-strong-matches'`) when none clear → submit the synthesis batch
    (`custom_id = d{runId}-{jobId}`; the batch id is logged before the step memoizes, so a crash in the
    create→memoize window leaves a traceable orphan) → durable `step.sleep` + a **bounded poll loop**
    on a fast→slow schedule (2m for the first hour, then 10m) that spans the API's 24h batch SLA in one
    attempt — step ids depend only on the loop index, never `ctx.attempt` (which also increments on
    STEP retries) → collect → persist (retry-idempotent: delete this `(user, run)` digest, then insert
    fresh; drop items with no usable reason, and **throw** if none survive — an all-errored synthesis
    is a failure, not an empty digest) → the Phase-F2 pre-send liveness probe (Arm C, below) → the Phase-11 email tail (below).
- `src/probe.ts` (Phase F2, Arm C) — the **pre-send liveness probe**: HEAD (GET-fallback on 405/501) the
  ≤`TOP_K` persisted items' apply URLs with a short timeout, then split DROP from CLOSE (locked decision 7) —
  a `404` or `410` DROPs the dead link from this digest (`dropDigestItemsAndRecount`), but only an explicit
  `410 Gone` ALSO soft-closes the job (`closeJobsByIds`, enforce-gated); a bare `404` drops without closing,
  and 2xx/3xx/5xx/timeout/network are KEPT (ambiguous — never lose a possibly-live match over a blip, never
  close). ONE memoized step (no synthesis-poll re-probe), over an injected probe seam (`DigestDeps.probe`,
  `deps.ts`); tallies onto `digests.counts` (`probedOk` / `probed404Dropped` / `probed410` / `probedErrorKept`
  …). An all-dropped set → 0 survivors → the caller keeps the 0-item audit row and sends no email. Shipped
  SHADOW: the `410` close is tallied as `probed410WouldClose`, not yet written. Enforcement is the single
  `F2_ENFORCE` switch — `buildDigestDeps` sets `DigestDeps.enforceLifecycle` from
  `parseEnforceFlag(process.env.F2_ENFORCE)` (the same flag that flips Arm A + Arm B in the Worker).
- `src/delivery.ts` (Phase 11) — `deliverDigestEmail(step, db, email, digestId)`, the post-persist
  step block: ONE `send-email` step (payload read → allowlist-gated Resend send with
  `Idempotency-Key: digest/<digestId>` → `recordDigestSent`) wrapped in the fail-run discipline (retry
  exhaustion → `delivery_status='failed'` → rethrow). G1b: `getDigestEmailPayload` filters items to
  `lifecycle_state='active'`, so a job closed between retrieval and send (an Arm A/B Worker tick during
  the synthesis wait — the probe checks only the apply URL, never lifecycle) never renders; if that
  empties the payload the step returns `"skipped-empty"` (no send, the orchestrator backs the user off
  the cadence) — distinct from the allowlist skip. Then a **bounded delivery poll** — sleep 2m,
  `GET /emails/:id`, and if still in flight one more 10m round — and ONE `record-delivery` step.
  `mapDeliveryEvent` encodes the pipeline policy: `delivered`/`opened`/`clicked` → `delivered`;
  `bounced` → `bounced` + **hard**-suppress (the poll's `last_event` carries no bounce subtype —
  Phase 12 webhooks refine this); `complained` → `delivered` + suppress WITHOUT touching bounce
  status; anything in flight stays `sent`. At-least-once safe end-to-end: the render is
  byte-deterministic, Resend replays the same email id for the key, and every write is idempotent.
  Split into its own file so the stub smoke drives the failure/skip/happy paths with a fake `step`.
- `src/deps.ts` — `buildDigestDeps()`: the production wiring — a neon-http `createDb` + the real Haiku
  rerank (the shared `@opusfinder/rerank` core wired to `generateObject` with `cacheSystem`, summing
  the cache counters across chunks) + the Anthropic batch primitives from `@opusfinder/llm` + the
  `@opusfinder/email` send/lastEvent pair (the serve process still boots without Resend creds — the
  email getters throw at call time, and an unconfigured send terminalizes to `'failed'`). Phase F2 added the `probe` seam (`DigestDeps.probe`) — the
  real `probeLiveness` (HEAD/GET apply-URL check) in production, a fake in the stub smoke. Phase F3
  threads the judgment-context prefs (`PromptPreferences` via `toPromptPrefs`) into rerank + synthesis —
  `DigestDeps.rerank` gained a `prefs?` arg and `deps.ts` forwards it.
- `src/backfill.ts` (Phase F8) — `createBackfillFunctions(deps)` → the scheduled drain that keeps the
  embedding backlog from accumulating on the deployed runtime (F8 rides the 12a runtime; the
  original GitHub Actions bridge was dropped):
  - **`embed-backlog-drain`** (`{ cron: "0 4 * * *", singleton: { mode: "skip" } }`): a **cursorless**
    re-query — each page re-selects `embedding IS NULL` (the just-written rows fall out of the predicate),
    so it self-advances with no cursor to thread.
  - It caps at `MAX_PAGES_PER_RUN = 200` PAGED per `step.run` (an uncapped drain would exceed the
    serverless `maxDuration`), and `singleton: { mode: "skip" }` keeps a long run from overlapping the next
    daily tick. The injection seam is `BackfillDeps` (`./backfill-deps` → `buildBackfillDeps()`: the
    neon-http `createDb` + the real Voyage embed from the new `@opusfinder/embeddings` dep),
    mirroring `DigestDeps`/`buildDigestDeps`.
- `scripts/test-digest-email.ts` (`pnpm --filter @opusfinder/inngest test:digest-email`) — the
  stub-seam smoke for the email tail: render determinism + escaping, the idempotency-key shape, the
  full event→status mapping, allowlist fail-closed, and the failure/skip/happy/slow-poll step
  sequences. NO creds, NO network, NO real DB.
- `scripts/test-digest-probe.ts` (`pnpm --filter @opusfinder/inngest test:probe`) — the stub-seam smoke for
  Arm C: `410` drops + closes, a single `404` drops but does NOT close, timeout/5xx/2xx keep, and an
  all-dropped set takes the empty-digest path. NO creds, NO network. Shares `scripts/_stub.ts` (the fake
  `step`/db/email harness deduped from the email smoke).
- `scripts/serve.ts` (`pnpm inngest:serve`) — the local serve endpoint over a bare Node `http` server
  (`inngest/node`) on port 3000 (pinned — the root `inngest:dev` registers exactly that URL), so the
  dev server can discover + invoke the functions. It now serves
  `[...createDigestFunctions(...), ...createBackfillFunctions(...), ...createHealthFunctions(...)]` (digest +
  F8 backfill + H1b health-check alerter). Dev-only —
  the Phase-12a **production** serve home is `apps/web/src/routes/api/inngest/+server.ts`
  (`inngest/sveltekit` on Vercel), which hosts the same function set; the Inngest SDK reads
  `INNGEST_SIGNING_KEY`/`INNGEST_EVENT_KEY` from the environment itself (auto-provisioned by the
  Inngest↔Vercel integration in prod).
- `scripts/digest.ts` (`pnpm digest`) — the manual trigger CLI: send `digest/run.requested`, then poll
  the DB until each targeted recipient has a NEW digest, and print it (item count, the rerank
  cache-read/create counters, and the top reasons). `process.exitCode` only (never `process.exit`).
- `scripts/show-health.ts` (`pnpm health`) — the **Phase-F6** CLI (NOT part of the digest function graph): runs
  `checkHealth` (the pure `@opusfinder/db/health` core) over live Neon, prints every check (ok / shadow-firing /
  enforce-firing) + the cost rollup, and on any **enforce**-mode firing pages the operator through the SHARED
  `src/health-alert.ts` path (H1b — same deduped logic the scheduled fn uses), then exits non-zero (shadow
  firings print but never page). Lives here — not in `@opusfinder/db` — because it both READS (db) and SENDS
  (email): inngest is the one package already depending on both, so it dodges a `db`⇄`email` workspace cycle.
  H1b note: it is **no longer purely read-only** — an enforce-firing check clear of the cooldown WRITES one
  `health_alerts` row + sends one email; `process.exitCode = 1` whenever unhealthy, even if cooldown-suppressed.
- `src/health-check.ts` + `src/health-deps.ts` (Phase H1b) — `createHealthFunctions(buildHealthDeps())` is the
  unattended **`health-check-alert`** Inngest cron fn (`*/30`, `singleton: skip`): `checkHealth` → dedup via
  `health_alerts` → `sendHealthAlert` a named-subsystem operator alert, page-once-per-`HEALTH_ALERT_COOLDOWN_H`
  (default 24h). Served alongside the digest + F8 functions in prod (`apps/web`). The CLI and the fn share
  `src/health-alert.ts` (`alertOnHealth` + the shape-only `formatMetric`/`checkDetail`) so they cannot drift on
  which checks page, the body shape, or the cooldown. Enforcing checks is env-only (`HEALTH_ENFORCE`); the seven
  checks still default `shadow`. No-creds smoke: `pnpm --filter @opusfinder/inngest test:health-alert`.

The `digest_runs` / `digests` / `digest_items` tables live in the unified `@opusfinder/db` schema +
migrations (`0007`/`0008`; `0009` adds the per-send `email_id`/`delivery_status`/`sent_at` columns);
the recipient/retrieval/persistence/delivery-state queries are `@opusfinder/db/repos`.

## Implementation refinements (vs `PHASE_10_PLAN.md`)

A few impl-time calls landed leaner/safer than the plan's defaults — recorded so the plan reads true:

- **Serve adapter:** `inngest/node` + a bare `http.createServer` (zero extra deps), not the plan's
  `inngest/hono` + `@hono/node-server` default. The dev driver doesn't bind the Phase-12 production
  adapter, so the lightest portable option won.
- **CLI surface:** `--user <uuid>` / `--all` (+ `--timeout-ms` / `--poll-ms`), not the plan's
  `--email` / `--dry-run`. Users are addressed by `user.id` directly (no email→id resolver step), with
  up-front uuid-shape + positive-int validation.
- **Synthesis wait:** a bounded sleep-poll loop (`SYNTH_MAX_POLLS` with distinct memoized step ids),
  not `RetryAfterError` — a function's retries cap at ~4, too few to span the batch SLA; the loop's
  sleeps suspend at zero cost and the batchId is memoized so a function-level retry re-polls the same
  batch.

## Local end-to-end (three terminals)

```powershell
# Terminal A — the local Inngest dev server (no account, no keys):
pnpm inngest:dev

# Terminal B — the serve endpoint (functions the dev server invokes):
$env:INNGEST_DEV=1; pnpm inngest:serve

# Terminal C — fire a manual run + poll for the result:
$env:INNGEST_DEV=1; pnpm digest --user <uuid>     # or: pnpm digest --all
```

Needs `DATABASE_URL` (packages/db/.env) + `ANTHROPIC_API_KEY` (packages/llm/.env) and a CV-ingested,
digest-enabled user; the Phase-11 send tail additionally needs `RESEND_API_KEY` (send) /
`RESEND_API_KEY_FULL` (the delivery poll's read — full access) / `EMAIL_FROM` / `EMAIL_ALLOWLIST`
(packages/email/.env) in the SERVE process. The dev server's dashboard
(http://localhost:8288) shows each step + the durable sleeps. Real, batch-discounted Anthropic spend;
a run takes a few minutes — and the CLI's verdict prints at persist, ~2–12 min BEFORE the send/poll
tail finishes (watch the dashboard before checking the delivery columns).

## Agent-can-do vs User-must-do (deploy split)

Per CLAUDE.md (external-platform integration), the work splits cleanly:

| Step | Who |
|---|---|
| All package code, the local dev server (`pnpm inngest:dev` — keyless), the end-to-end gate | **Agent** |
| Provide `DATABASE_URL` + `ANTHROPIC_API_KEY` (already in place since Phase 9) | **User** |
| **Resend account + API key + verified sending domain (SPF/DKIM/DMARC) + `EMAIL_FROM`/`EMAIL_ALLOWLIST`** | **User (Phase 11)** |
| Production serve route (SvelteKit-on-Vercel, `apps/web`) + the cadence cron (`0 13 * * *`) + the F8 backfill cron | Built + deployed (12a; live 2026-06-17) |
| **Inngest Cloud account + app sync; `INNGEST_SIGNING_KEY`/`INNGEST_EVENT_KEY` auto-provisioned by the Inngest↔Vercel integration (`INNGEST_DEV` UNSET)** | Done (User, deployed 2026-06-17) |
