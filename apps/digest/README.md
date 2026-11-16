# @opusfinder/digest-worker

The Cloudflare Worker `opusfinder-digest`: the per-user digest on Cloudflare Workflows, and the health
check. It runs the stage code in [`@opusfinder/digest`](../../packages/digest) and adds nothing to it but
the engine.

## How it works

`src/index.ts` exports a `scheduled` handler that switches on `controller.cron`:

| Cron (UTC)     | Tick         | What it does                                                                |
| -------------- | ------------ | --------------------------------------------------------------------------- |
| `10 12 * * *`  | digest       | starts the orchestrator Workflow (`DigestRunWorkflow`) for the tick's date  |
| `10 */2 * * *` | health check | runs `runHealthCheck` in the handler and writes one ledger row              |

Both fire 10 minutes after an ingestion tick starts (the scrapers Worker, `0 */2 * * *`), so Neon is awake.

- **The orchestrator** opens a `digest_runs` row, sweeps the users whose cadence is due and starts one
  `DigestUserWorkflow` run for each. Its instance id is the tick's date, so a double cron fire runs once.
- **A user's run** is load → retrieve → rerank → synthesis batch (with its waits) → persist → liveness
  probe → delivery. Its id is the user plus the tick's date. Before starting one, the fan-out
  (`src/fan-out.ts`) asks the engine about the instance last started for that user
  (`user_preferences.digest_instance_id`) and skips the user while it hasn't finished, so a user never has
  two runs at once. A run that fails doesn't stamp the user, who is due again at the next daily tick.
- **Steps** run under one retry policy (`src/steps.ts`): 4 retries after the first attempt, 5 minutes an
  attempt. The stages' `NonRetriableError` is never retried. A failed query is reduced to its Postgres
  reason and its SQL before the engine stores it (drizzle's message carries the query's parameters).

## The control plane is the only switch

There are no `[vars]`. Each tick reads its stage's gate over the `CONTROL` service binding
(`src/control.ts`) and does nothing unless the stage is on. Off and unreadable are the same: nothing
starts. Both stages ship **off**.

| Stage    | Off                 | Logs only                                                               | On                                              |
| -------- | ------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| `digest` | starts no run       | builds and stores every due user's digest (paid rerank and synthesis); sends nothing | an account set to `email` is sent; `logs` is stored |
| `alerts` | runs no check       | (the stage has no such mode)                                            | runs the checks; a check emails only when its own row says enforce |

- The send step reads the `digest` mode again at the send boundary, so a stage turned to logs only or off
  during the batch wait stops the email.
- An account's own setting is `user_preferences.digest_delivery` (`pnpm user:set-prefs --delivery email|logs`,
  default `logs`). A logs-only digest keeps `delivery_status = 'none'` and no `sent_at`, and takes the
  user's cadence slot.
- With `alerts` on and every check in shadow (the default), the health tick reports what fires in its log
  and its ledger row and emails nothing.
- Also read from the gate: the `close` policy (the liveness probe's 410 close), `digest.maxRecipientsPerRun`
  (the most user runs one tick starts; the rest stay due and go first next time), each health check's mode
  and threshold, and `alerts.cooldownH`. `digest.topK` is not read: it is a constant in the stage code.

## Secrets

All set with `wrangler secret put <NAME>` from this directory, except `DATABASE_URL`:

| Secret                | What it is                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | Neon as the limited `digest_worker` role. Set by `pnpm --filter @opusfinder/db run digest-role:setup`, never by hand |
| `OPENROUTER_API_KEY`  | The rerank and the synthesis batch. Can be its own key with a credit limit                    |
| `RESEND_API_KEY`      | Sends the digest and health alerts. A sending-only key is enough                              |
| `RESEND_API_KEY_FULL` | Reads an email's delivery state after the send. Needs full access (a sending-only key gets 401) |
| `EMAIL_FROM`          | The verified sender address                                                                   |
| `ALERT_TO`            | Where health alerts go. Needed before any health check is set to enforce                      |

## Deploy (owner)

Order matters: the column before the code that reads it, the control Worker before this one (it has to
know this Worker's runtime id to accept its ledger rows), and the Worker has to exist before a secret can
be put on it.

```sh
pnpm db:migrate \
  && pnpm --dir apps/control exec wrangler deploy \
  && pnpm --dir apps/digest run deploy \
  && pnpm --filter @opusfinder/db run digest-role:setup
```

Then put the other secrets, and check through Cloudflare that **both** cron strings fire (a deploy's output
and the schedules list are not proof: a replaced trigger has kept firing before). With both stages off,
each tick only writes a `skipped` ledger row.

After a migration that adds a table the digest or the health check uses, re-run `digest-role:setup`
(grants are per table).

## Tests

All node-side (`pnpm test`), none needs a secret:

- `src/parity.integration.test.ts`: the stages, driven through the step adapter on PGlite, reproduce the
  record made from the Inngest-hosted code (`test/digest/parity.fixture.json`).
- `src/engine.integration.test.ts`: the fan-out and the step adapter inside a Workflow on Miniflare's local
  engine (one run per id, a run that spans ticks, retries, what an errored instance stores).
- `src/worker.integration.test.ts`: the real bundle in workerd with no compatibility flags; nothing runs
  unless the gate says on.
- `src/fan-out.test.ts`, `src/steps.test.ts`, `src/control.test.ts`: the rules themselves, including the
  sync with the registry and `wrangler.toml`.
