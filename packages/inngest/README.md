# @opusfinder/inngest

The per-user digest pipeline on **Inngest** — the durable orchestration that turns a user
profile + the live job corpus into ranked `digests` / `digest_items` rows with per-job reasons, then
emails them (Phase 11). The sequence is: deterministic filter → pgvector retrieval (top ~50 vs
`user_profiles.embedding`) → **synchronous** Haiku rerank (prompt-cached) → **batched** Sonnet
synthesis (Anthropic Message Batches API) → persist → **send (Resend, idempotency-keyed) → bounded
delivery poll → record** (`src/delivery.ts`).

> **Phases 10/11 are LOCAL-DEV-ONLY.** They run against the local Inngest dev server
> (`npx inngest-cli dev`, `INNGEST_DEV=1`) — **no Inngest Cloud account, no signing/event keys, no
> deployed serve endpoint**. The production serve home (SvelteKit-on-Vercel via `inngest/sveltekit`),
> the cadence cron, and delivery webhooks are **Phase 12**.

> **Worker invariant.** Inngest functions are a Node/server runtime that read Neon directly as a
> trusted process — this package must NEVER enter the `apps/scrapers` Cloudflare Worker bundle. Both
> `@opusfinder/inngest` and `inngest` are on `pnpm guard:worker`'s deny lists.

## Why Inngest (and why local-dev-only)

The synthesis step submits an Anthropic **Message Batch** (50% discount) and then waits for it — most
batches finish in under an hour but the SLA is a 24h hard cap. Inngest's durable `step.sleep` /
`step.run` suspend across that wait at **zero compute cost**, which a vanilla Cloudflare cron tick
cannot (hard 15-min wall, no cross-invocation suspend). That durability is the decisive reason the
digest runs on Inngest rather than extending `apps/scrapers`. Phase 10 only needs the local dev server
to prove the pipeline end-to-end; the deployed runtime + keys land in Phase 12 (email ships in
Phase 11 on the local dev runtime — locked at Phase-11 planning, 2026-06-11).

## What's here

- `src/inngest.ts` — the `inngest` client (`id: "opusfinder"`) + the typed event surface
  (`EventSchemas().fromRecord`): `digest/run.requested` (kicks the orchestrator — manual CLI now, a
  cadence cron in Phase 12; optional `userId` scopes it to one user) and `digest/user.requested` (one
  per recipient, fanned out by the orchestrator).
- `src/digest.ts` — `createDigestFunctions(deps)` → `[orchestrator, perUser]`, plus the `DigestDeps`
  injection seam (`db` + a `rerank` closure + the `batch` submit/poll/collect lifecycle + the Phase-11
  `email` send/lastEvent pair) so the pipeline is stub-testable and the heavy `@opusfinder/llm` wiring
  stays out of the function bodies.
  - **Orchestrator** (`digest-orchestrator`): opens a `digest_run`, resolves recipients (single user
    when `event.data.userId` is set — runtime-validated as a uuid, since the event schema is
    compile-time only — else every eligible user keyset-swept), fans out one `digest/user.requested`
    each via `step.sendEvent`, and finalizes the run to the dispatch count. Fan-out is fire-and-forget,
    so the run row records **dispatch**, not per-user completion (those land on `digests`). A step that
    exhausts its retries is caught and terminalized onto the run row (`status: 'error'` +
    `error_sample`) before the failure is rethrown.
  - **Per-user** (`digest-user`, `singleton` keyed on `userId`, mode `skip` — `concurrency` would
    release its slot during the batch-wait sleeps and let runs overlap): load + **eligibility gate**
    (skip if no profile/embedding, unverified email, `!digestEnabled`, or suppressed — so even a manual
    single-user trigger respects an opt-out and matches the `--all` sweep's gate) → retrieve (geo +
    exclusion keywords applied inside retrieval's post-filter, before its over-fetch trim) → sync
    rerank (top-K, with the prompt-cache counters for the gate) → submit the synthesis batch
    (`custom_id = d{runId}-{jobId}`; the batch id is logged before the step memoizes, so a crash in the
    create→memoize window leaves a traceable orphan) → durable `step.sleep` + a **bounded poll loop**
    on a fast→slow schedule (2m for the first hour, then 10m) that spans the API's 24h batch SLA in one
    attempt — step ids depend only on the loop index, never `ctx.attempt` (which also increments on
    STEP retries) → collect → persist (retry-idempotent: delete this `(user, run)` digest, then insert
    fresh; drop items with no usable reason, and **throw** if none survive — an all-errored synthesis
    is a failure, not an empty digest) → the Phase-11 email tail (below).
- `src/delivery.ts` (Phase 11) — `deliverDigestEmail(step, db, email, digestId)`, the post-persist
  step block: ONE `send-email` step (payload read → allowlist-gated Resend send with
  `Idempotency-Key: digest/<digestId>` → `recordDigestSent`) wrapped in the fail-run discipline (retry
  exhaustion → `delivery_status='failed'` → rethrow); then a **bounded delivery poll** — sleep 2m,
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
  email getters throw at call time, and an unconfigured send terminalizes to `'failed'`).
- `scripts/test-digest-email.ts` (`pnpm --filter @opusfinder/inngest test:digest-email`) — the
  stub-seam smoke for the email tail: render determinism + escaping, the idempotency-key shape, the
  full event→status mapping, allowlist fail-closed, and the failure/skip/happy/slow-poll step
  sequences. NO creds, NO network, NO real DB.
- `scripts/serve.ts` (`pnpm inngest:serve`) — the local serve endpoint over a bare Node `http` server
  (`inngest/node`) on port 3000 (pinned — the root `inngest:dev` registers exactly that URL), so the
  dev server can discover + invoke the functions. Dev-only. The Phase-12 production serve will need
  `INNGEST_SIGNING_KEY`/`INNGEST_EVENT_KEY`, which the Inngest SDK reads from the environment itself.
- `scripts/digest.ts` (`pnpm digest`) — the manual trigger CLI: send `digest/run.requested`, then poll
  the DB until each targeted recipient has a NEW digest, and print it (item count, the rerank
  cache-read/create counters, and the top reasons). `process.exitCode` only (never `process.exit`).

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
| **Inngest Cloud account + `INNGEST_SIGNING_KEY`/`INNGEST_EVENT_KEY` + a deployed serve endpoint + app sync** | **User (Phase 12)** |
| Decide the production serve host (SvelteKit-on-Vercel) + the cadence cron schedule/timezone | **User (Phase 12)** |
