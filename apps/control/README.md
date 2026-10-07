# @opusfinder/control-plane

The **control Worker** (`opusfinder-control`): slice 1 of the edge control plane — candidate B in
`research/rnd/control-surface-architecture.md` (local-only). One small Cloudflare Worker + one D1
database that hold the project's **desired state** (every stage, policy, knob and slice override),
its **change log**, the **approval queue** and a **run ledger**, behind Cloudflare Access.

It never holds a Neon credential and bundles nothing that could reach Neon (`pnpm guard:worker`
allow-lists its bundle to `apps/control/src` + `packages/control/src`), so reading or flipping a
switch can't wake the database (C4).

**Not in slice 1** (by design): no runtime is wired to the gate yet (the scrapers Worker and Inngest
keep obeying their env vars until a later slice adds the gate in shadow), no drift probes, no prices
or reconciliation, no notifications, no observer agent.

## Pieces

| Path                          | What                                                                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/control`            | The pure registry (`registry.ts`), target addresses (`targets.ts`), the fail-closed resolver / `effectiveMode()` (`resolve.ts`), `classify(change, role)` (`classify.ts`) and the read models (`views.ts`). Worker-safe, dependency-free. |
| `apps/control/src/index.ts`   | HTTP routing (JSON API + the page + its form posts) and the `ControlRpc` entrypoint.                                                                                                                                                      |
| `apps/control/src/auth.ts`    | Caller identity from a verified Access token (default deny).                                                                                                                                                                              |
| `apps/control/src/service.ts` | The operations, shared by API, page and RPC.                                                                                                                                                                                              |
| `apps/control/src/store.ts`   | All SQL; the atomic state + change-log write.                                                                                                                                                                                             |
| `apps/control/src/page.ts`    | The one server-rendered page.                                                                                                                                                                                                             |
| `apps/control/migrations/`    | `0001_init.sql` (tables), `0002_seed.sql` (today's reality).                                                                                                                                                                              |
| `packages/ctl`                | `pnpm ctl`, the Node CLI agents use.                                                                                                                                                                                                      |

## Who can do what

The credential is the role (§11.1). Every HTTP request is identified **before routing** from the
`Cf-Access-Jwt-Assertion` header that Cloudflare Access attaches to everything it lets through. The
Worker verifies that token itself — RS256 signature against the team's JWKS
(`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached 10 min, refetched at most every
30 s on an unknown key id; if a refetch fails the last good keys keep working for up to 24 h while
retries back off from 30 s to 10 min), `iss` = the team domain, `aud` contains this app's AUD tag, `exp`/`nbf`,
`type: "app"` — then maps it:

| Token                                       | Role                     | Condition                                                          |
| ------------------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| human (`email` + `sub`)                     | **owner**                | email is in `OWNER_EMAILS`; anyone else Access admits gets 403     |
| service token (`common_name` = client id)   | **agent** or **runtime** | client id is in `SERVICE_TOKENS`; an unlisted token gets 403       |
| no / invalid token                          | —                        | 401 (even for unknown routes: nothing is revealed before identity) |
| missing `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | —                        | 503 for every request                                              |

A **service binding** reaching the `ControlRpc` entrypoint is the **runtime** role (Access never sees
binding traffic, and RPC methods can't be reached over HTTP). A binding's plain `fetch()` carries no
Access token and is refused like any anonymous request.

What each role may change is decided by `classify()` in `packages/control`:

- **owner** — anything; approves or rejects proposals.
- **agent** — moves toward less spend/risk apply immediately (turn a stage off, lower a spend knob,
  add a narrowing override); anything else must be proposed. Entries declared `agent: "approval"` in
  the registry need approval for **any** change, quieter or louder, knobs included: the **master
  switch** (an agent may stop any single spending stage, not everything at once), the **alerts**
  stage (an agent may not silence alerting) and the **8 health checks**. Posture repairs
  (re-enabling a platform schedule) are agent-safe.
- **runtime** — read gates, write ledger rows, `trip(stage, reason)` which can only set a stage off.

**Why there is no local identity shortcut.** The Worker has exactly one way to learn who is
calling — the verified JWT — and no code path that trusts anything else (no header, cookie, env flag
or `ctx.access`). Wrangler's `[access.dev]` block simulates `ctx.access` locally; this Worker never
reads `ctx.access`, so that block can grant nothing, locally or deployed. The tests exercise the
production path end to end: they mint tokens with a throwaway keypair and serve its public key from a
Miniflare outbound-fetch stub — the network is faked, the code is not.

## JSON API

Bodies are optional where a route needs none (approve, reject, withdraw: no body and no content type
is fine). A body that is sent must be a JSON **object** declared `application/json` — any other declared
type is 415 — and at most 16 KB, counted in bytes. Every POST that a browser marks as cross-site
(`Origin` of another site, or `Sec-Fetch-Site` other than `same-origin`) is refused (403
`cross_origin`), so another site can't drive the API with the owner's Access cookie. Errors are
`{ "error": { "code", "message" } }`.

| Route                                                                                               | Roles                          | What                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/status`                                                                                    | owner, agent                   | Every stage/policy/knob: desired + effective mode, last ledger row, recent changes, open proposals.                                                                                                                     |
| `GET /v1/gate/:stage[?source=…&lane=…]`                                                             | all                            | "May I run, and with what settings?" — effective mode (narrowed to the slice), knobs, the policies the stage reads, set overrides, and `since`/`by`/`because`.                                                          |
| `POST /v1/changes` `{target, value, reason, proposeIfNeeded?, dryRun?}`                             | owner, agent                   | Applies if `classify` allows; else **403 `needs_approval`** with a ready-to-send `propose` body, or — with `proposeIfNeeded: true` — files it and answers **202 `proposed`**. Re-setting the current value is a `noop`. |
| `GET /v1/proposals[?status=all]`                                                                    | owner, agent                   | Open (default) or all proposals; `status` reads `expired` past 7 days. In `/v1/status`, each open proposal also says whether it is `stale` (see approve).                                                               |
| `POST /v1/proposals` `{target, value, reason}`                                                      | owner, agent                   | File a proposal. Idempotent: an open one with the same target, current value and proposed value is returned (200, `duplicate: true`).                                                                                   |
| `GET /v1/proposals/:id`                                                                             | owner, agent                   | One proposal.                                                                                                                                                                                                           |
| `POST /v1/proposals/:id/approve` (optional `{note}`)                                                | owner                          | Applies it and closes it in **one D1 batch** — unless the target has moved off the value it was proposed from: then **409 `stale_proposal`**, closed as `stale` with the reason, nothing applied.                       |
| `POST /v1/proposals/:id/reject` (optional `{note}`)                                                 | owner                          | Closes it.                                                                                                                                                                                                              |
| `POST /v1/proposals/:id/withdraw` (no body)                                                         | the proposer                   | Takes it back.                                                                                                                                                                                                          |
| `POST /v1/runs` `{stage, outcome, startedAt, finishedAt?, durationMs?, gateMode?, units?, detail?}` | runtime                        | One ledger row; units must be ones the stage declares, each 0 … 2^53−1; `durationMs` at most 7 days; out of range is 400 `invalid_run`.                                                                                 |
| `POST /v1/trip` `{stage, reason: runaway\|error-storm, detail?}`                                    | runtime                        | Turns the stage off, logged.                                                                                                                                                                                            |
| `GET /` and `POST /ui/…`                                                                            | owner (agents: read-only page) | The page and its same-origin form posts.                                                                                                                                                                                |

Targets: `global`, `<stage>`, `<policy>`, `<entry>.<knob>`, `<stage>@<dim>=<value>` (e.g.
`ingest@source=smartrecruiters`; value `inherit` clears an override, and an override at the stage's
top mode caps nothing, so it is stored as no override — setting one where none exists is a no-op).
Every registry dimension is also a `/v1/gate` query parameter.

RPC (`ControlRpc`, for a service binding): `gate(stage, dims?)`, `recordRun(run)`,
`trip(stage, reason, detail?)`. A binding may pass `props = { name = "…" }` as its audit label.

## Storage and the fail-closed rules

D1 tables: `state` (one row per target), `change_log` (append-only), `proposal`, `ledger`. Every
state change and its change-log row are written in the **same `db.batch()`** (one transaction), and
both statements are conditional on the state still holding the value the caller was classified
against — so a concurrent trip can't turn an agent's safe "on → shadow" into an unapproved
"off → shadow".

Fail-closed (owner decision, ingest included): a **missing row** reads as the registry default; an
**unrecognised value** reads as `off` (a knob: its least risky bound); an **unreachable store** means
the caller skips its tick (the gate clients of later slices; this Worker answers 5xx).

## Local development

```bash
pnpm --filter @opusfinder/control-plane db:migrate:local   # local D1 under apps/control/.wrangler
cp apps/control/.dev.vars.example apps/control/.dev.vars   # fill in the real team domain + AUD
pnpm --filter @opusfinder/control-plane dev                # wrangler dev on :8787
```

There is no identity bypass locally either: send a real Access token for the deployed app, e.g.
`cloudflared access login <url>` then `cloudflared access token -app=<url>` (cloudflared is in
nixpkgs), as `curl -H "cf-access-jwt-assertion: $TOKEN" http://localhost:8787/v1/status`.

Tests: `pnpm test` runs the Miniflare suites (`src/*.integration.test.ts`) — the real Worker bundle
in workerd against a real local D1 with these migrations — plus the `packages/control` and
`packages/ctl` unit tests.

## Owner provisioning checklist

Run from a NixOS terminal in the repo, logged in to wrangler as yourself (`pnpm exec wrangler login`
if `pnpm exec wrangler whoami` says otherwise). Nothing here needs to be run by an agent.

**1. Create the database and apply the migrations**

Done on 2026-10-07: `opusfinder-control` exists (region WNAM) and its `database_id` is in
`apps/control/wrangler.toml`. To recreate it from scratch:

```bash
cd ~/projects/opusfinder/apps/control
pnpm exec wrangler d1 create opusfinder-control
```

Copy the printed `database_id` into `apps/control/wrangler.toml` (if wrangler offers to edit the config
for you, decline — the binding must stay `DB`). Then:

```bash
pnpm exec wrangler d1 migrations apply opusfinder-control --remote
pnpm exec wrangler d1 execute opusfinder-control --remote --command "SELECT key, value FROM state ORDER BY key"
```

Expect 18 rows: global/ingest/discover/cv_ingest `on`, embed/alerts/digest/live_integration `off`,
close `enforce`, stale_sweep and the 8 `health.*` `shadow`.

**2. Deploy**

```bash
pnpm exec wrangler deploy
curl -s -o /dev/null -w '%{http_code}\n' https://opusfinder-control.<your-subdomain>.workers.dev/v1/status
```

Note the printed `workers.dev` URL. The curl answers **503** until step 5 (no Access config: fail
closed).

**3. Protect the Worker behind Access** (dashboard)

1. Workers & Pages → `opusfinder-control` → **Access** → **Protect this Worker behind Access** →
   **All traffic**. Pick any offered policy for now; the modal shows the **AUD tag** and the **team
   domain** (`https://<team>.cloudflareaccess.com`) — keep both for step 5.
2. Zero Trust → Access → Applications → the new app → **Policies**. Make the human policy exactly:
   Action **Allow**, Include → **Emails** → your login address. Not an email _domain_ (a
   `gmail.com` domain rule would admit every Gmail user — the Worker's `OWNER_EMAILS` would still
   refuse them, but don't rest on one layer). Remove any broader policy.
3. **Login method** (Zero Trust → Settings → Authentication):
   - **One-time PIN — recommended.** On by default, nothing to set up, works on a phone; each new
     session costs one emailed code. Set the app's session duration to taste (e.g. 24 h).
   - **GitHub** — one tap where you're already signed in to GitHub, but you must create a GitHub
     OAuth app (callback `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`) and your
     GitHub session becomes a key to the panel.

**4. Create the agent service token** (dashboard)

1. Zero Trust → Access → Service credentials → **Service Tokens** → **Create service token**, name
   `opusfinder-agent`, duration 1 year (add a renewal reminder). Copy the **Client ID** and the
   **Client Secret** — the secret is shown once.
2. Back in the app's **Policies**, add: Action **Service Auth**, Include → **Service Token** →
   `opusfinder-agent`.

**5. Set the Worker's secrets** (each command prompts for the value, so nothing lands in shell
history; each one re-deploys)

```bash
cd ~/projects/opusfinder/apps/control
pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN   # https://<team>.cloudflareaccess.com
pnpm exec wrangler secret put ACCESS_AUD           # the AUD tag from step 3
pnpm exec wrangler secret put OWNER_EMAILS         # your login email (comma-separate several)
pnpm exec wrangler secret put SERVICE_TOKENS       # {"<Client ID>":{"role":"agent","name":"agent"}}
```

The Client ID looks like `0123abcd….access`; paste it whole as the JSON key. `name` is what the
change log will show (`agent:agent`).

**6. Write the CLI config**

```bash
install -d -m 700 ~/.config/opusfinder-agent
install -m 600 /dev/null ~/.config/opusfinder-agent/ctl.json
nano ~/.config/opusfinder-agent/ctl.json
```

```json
{
  "url": "https://opusfinder-control.<your-subdomain>.workers.dev",
  "clientId": "<Client ID>",
  "clientSecret": "<Client Secret>"
}
```

(`OPUSFINDER_CTL_URL` / `OPUSFINDER_CTL_CLIENT_ID` / `OPUSFINDER_CTL_CLIENT_SECRET` override the
file per field.)

**7. Verify**

```bash
cd ~/projects/opusfinder
pnpm ctl status                                    # the table; "you: agent:agent"
pnpm ctl set ingest.boardsPerTick 250 --reason "provisioning smoke test"   # no change, exit 0
pnpm ctl set embed shadow --reason "provisioning smoke test: approval path" --propose   # exit 3
curl -s -o /dev/null -w '%{http_code}\n' https://opusfinder-control.<your-subdomain>.workers.dev/v1/status
```

The curl now answers **302** or **403** (Access stops it before the Worker). Open the URL on your phone, sign in, find
the proposal at the top and **Reject** it; `pnpm ctl proposals --all` then shows it rejected.

If `pnpm ctl status` says `no Cloudflare Access identity on this request` (401), Access isn't
attaching its token to this Worker. Fallback: delete the Worker-level rule and protect the
`workers.dev` hostname with a self-hosted Access application instead (Zero Trust → Access →
Applications → Add → Self-hosted), with the same two policies; use that app's AUD tag.

**8. Keep the boundary real** (owner settings, §11.4)

- Add Claude Code `deny`/`ask` rules for `wrangler d1`, `wrangler deploy`, `wrangler secret` and
  `wrangler kv` — your wrangler login could otherwise bypass the API and its rules.
- Agents run `pnpm ctl` in their sandbox: it must be able to read `~/.config/opusfinder-agent` and
  reach the `workers.dev` hostname (add it to the sandbox network allowlist).
- Don't grant the browser extension the panel's hostname.

**Break-glass** (Access locks you out): edit D1 directly as yourself and log it by hand —

```bash
pnpm exec wrangler d1 execute opusfinder-control --remote --command "UPDATE state SET value = 'off', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = 'break-glass:owner' WHERE key = 'embed'; INSERT INTO change_log (at, actor_role, actor_name, target, from_value, to_value, reason, channel) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'break-glass', 'owner', 'embed', 'on', 'off', 'break-glass: Access lockout', 'break-glass')"
```

## Known gaps (slice 1)

- No runtime reads the gate yet; until the shadow slice, flipping a switch here changes the record,
  not behaviour. The deployed env vars (`INGEST_LIMIT`, `LIFECYCLE_CLOSE_ENFORCE`, `STALE_SWEEP*`, …)
  still rule.
- `HealthCheckId` still lives in `packages/db/src/health.ts`; a sync test in `@opusfinder/db` pins the
  registry to it until it moves here.
- The registry copies its runtimes' crons, platform ids and knob values (`packages/control` can't
  import them). Sync tests (`control-registry.test.ts` in `apps/scrapers`, `packages/inngest` and
  `packages/db`) fail when one side changes alone, but they pin only:
  - the `ingest` and `discover` crons, through the scrapers Worker's own dispatch;
  - the Inngest stage crons (`embed`, `alerts`, `digest`) and their `platformId`s, read off the
    functions the serve routes register;
  - `ingest.boardsPerTick`'s default, min and max;
  - the `discover` knob defaults;
  - the `health.*` check ids, threshold defaults and env var names.

  **Not pinned** (keep both sides in step by hand): the `live_integration` cron
  (`.github/workflows/live-integration.yml`), the `discover` knobs' min/max, every `expect` period
  (update it with its cron), `embed.pagesPerRun`, `digest.topK`, `stale_sweep.ttlDays` and
  `alerts.cooldownH`.
- Approvals don't force a fresh Access login (feasibility unverified).
- Proposals expire lazily (read-time), with no notification.

### Follow-ups

- Pin each value listed as **not pinned** above.
- Move the scrapers Worker's schedule and limit constants into a sibling module (e.g.
  `apps/scrapers/src/schedule.ts`; workerd rejects only the main module's `export const`), so
  `dispatch.test.ts` imports them instead of keeping literal copies.
- Merge the duplicated test scaffolding: the scrapers Worker's `dispatch.test.ts` and
  `control-registry.test.ts` each mock the pipelines and drive `scheduled()`, and the Inngest
  `crons.test.ts` and `control-registry.test.ts` each build the functions to read their triggers.
- Add a test that derives each stage's `expect.everyMin` from the shape of its cron.
