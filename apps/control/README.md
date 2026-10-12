# @opusfinder/control-plane

The **control Worker** (`opusfinder-control`): slice 1 of the edge control plane — candidate B in
`research/rnd/control-surface-architecture.md` (local-only). One small Cloudflare Worker + one D1
database that hold the project's **desired state** (every stage, policy, knob and slice override),
its **change log**, the **approval queue** and a **run ledger**, behind Cloudflare Access.

It never holds a Neon credential and bundles nothing that could reach Neon (`pnpm guard:worker`
allow-lists its bundle to `apps/control/src`, `packages/control/src` and postal-mime), so reading
or flipping a switch can't wake the database (C4).

**Not built yet** (by design): no runtime OBEYS the gate — the scrapers Worker reads it in shadow (see
"Runtimes wired" below) and Inngest doesn't read it at all, so both keep obeying their env vars — no
drift probes, no notifications, no observer agent.

## Pieces

| Path                             | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/control`               | The pure registry (`registry.ts`), target addresses (`targets.ts`), the fail-closed resolver / `effectiveMode()` (`resolve.ts`), `classify(change, role)` (`classify.ts`), the read models (`views.ts`) and missed-tick detection (`cadence.ts`). Worker-safe, dependency-free.                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/control/src/index.ts`      | HTTP routing (JSON API + the page + its form posts) and the `ControlRpc` entrypoint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/control/src/auth.ts`       | Caller identity from a verified Access token (default deny).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/control/src/service.ts`    | The operations, shared by API, page and RPC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/control/src/store.ts`      | All SQL; the atomic state + change-log write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `apps/control/src/ui/`           | The panel's server-rendered pages. Shared: `layout.ts` (page shell, sections, nav), `components.ts` (cards, rows, `controlRow` for every switch and setting, tables, tiles, tabs, filters), `vocab.ts` (how modes, wiring, targets and people are said), `format.ts` (times, numbers, money), `style.ts` (the stylesheet), `forms.ts` (the in-place controls: a mode dropdown or number field whose Confirm and Cancel appear only once it's changed), `log.ts` (the Log's tabs and page scaffold). Pages: one module per section (`home`, `approvals`, `stages`, `health`, `cost`) and per Log tab (`runs`, `changes`; closed proposals live in `approvals`). |
| `apps/control/src/mailbox.ts`    | The billing mailbox: the `email()` handler's logic (Email Routing → one `statement` row per forwarded invoice).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/control/src/statements.ts` | Reading one invoice email: Gmail's forwarding code, the Workers AI read (JSON mode, PDF fallback), field validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/control/migrations/`       | `0001_init.sql` (tables), `0002_seed.sql` (today's reality), `0003_ledger_started.sql` (run-time indexes), `0004_statements.sql` (the Cost page's statements), `0005_statement_auth.sql` (the mailbox's auth evidence), `0006_change_reason_optional.sql` (the owner's changes need no reason).                                                                                                                                                                                                                                                                                                                                                                |
| `packages/ctl`                   | `pnpm ctl`, the Node CLI agents use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

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
  stage (an agent may not silence alerting) and the **8 health checks**.
- **runtime** — read gates; write ledger rows and `trip(stage, reason)` (which can only set a stage
  off) for **its own** stages: those whose registry `runtime` is the caller's name (the token's `name`,
  the binding's `props.name`).

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

| Route                                                                                                                 | Roles                           | What                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/status`                                                                                                      | owner, agent                    | Every stage/policy/knob: desired + effective mode, last ledger row, when the stage is next due and whether it is `overdue` (from its `expect` period), run counts for the last 24 h (`recentRuns`), recent changes, open proposals.                                                                 |
| `GET /v1/runs[?stage=…&outcome=…&from=…&to=…&before=<id>&limit=…]`                                                    | owner, agent                    | The run ledger, newest start first, 50 per page (max 200); `more: true` means pass the last row's id as `before`.                                                                                                                                                                                   |
| `GET /v1/changes[?stage=…&from=…&to=…&before=<id>&limit=…]`                                                           | owner, agent                    | The change log, newest first; `stage` keeps that stage's own targets (the stage, its knobs, its overrides).                                                                                                                                                                                         |
| `GET /v1/cost[?from=…&to=…\|month=YYYY-MM]`                                                                           | owner, agent                    | What vendors charged: totals per month and vendor, the statements filed in the period (whole months of `from`/`to`, else `month`, else this month), the review queue, the advisory target and the vendor ceilings. Amounts in US cents.                                                             |
| `POST /v1/statements` `{vendor, amount, chargedOn, kind?, periodStart?, reference?, note?}`                           | owner, agent                    | Record a charge by hand (history, or a vendor that emails no invoice). A repeat of a counted charge (from an agent, also of one still in review) is stored as `duplicate`.                                                                                                                          |
| `GET /v1/gate/:stage[?source=…&lane=…]`                                                                               | all                             | "May I run, and with what settings?" — effective mode (narrowed to the slice), knobs, the policies the stage reads, set overrides, and `since`/`by`/`because`.                                                                                                                                      |
| `POST /v1/changes` `{target, value, reason, proposeIfNeeded?, dryRun?}`                                               | owner, agent                    | Applies if `classify` allows; else **403 `needs_approval`** with a ready-to-send `propose` body, or — with `proposeIfNeeded: true` — files it and answers **202 `proposed`**. Re-setting the current value is a `noop`. `reason` is required from an agent; the owner may leave it out.             |
| `GET /v1/proposals[?status=all\|closed]`                                                                              | owner, agent                    | Open (default) or all proposals, or `closed` (decided, stale, withdrawn or lapsed) paged like the run list with `stage`/`outcome`/`from`/`to`/`before`/`limit` and `more`; `status` reads `expired` past 7 days. In `/v1/status`, each open proposal also says whether it is `stale` (see approve). |
| `POST /v1/proposals` `{target, value, reason}`                                                                        | owner, agent                    | File a proposal. Idempotent: an open one with the same target, current value and proposed value is returned (200, `duplicate: true`).                                                                                                                                                               |
| `GET /v1/proposals/:id`                                                                                               | owner, agent                    | One proposal.                                                                                                                                                                                                                                                                                       |
| `POST /v1/proposals/:id/approve` (optional `{note}`)                                                                  | owner                           | Applies it and closes it in **one D1 batch** — unless the target has moved off the value it was proposed from: then **409 `stale_proposal`**, closed as `stale` with the reason, nothing applied.                                                                                                   |
| `POST /v1/proposals/:id/reject` (optional `{note}`)                                                                   | owner                           | Closes it.                                                                                                                                                                                                                                                                                          |
| `POST /v1/proposals/:id/withdraw` (no body)                                                                           | the proposer                    | Takes it back.                                                                                                                                                                                                                                                                                      |
| `POST /v1/runs` `{stage, outcome, startedAt, finishedAt?, durationMs?, gateMode?, units?, detail?}`                   | runtime                         | One ledger row; units must be ones the stage declares, each 0 … 2^53−1; `durationMs` at most 7 days; out of range is 400 `invalid_run`.                                                                                                                                                             |
| `POST /v1/trip` `{stage, reason: runaway\|error-storm, detail?}`                                                      | runtime                         | Turns the stage off, logged.                                                                                                                                                                                                                                                                        |
| `GET /`, `/approvals`, `/stages`, `/stages/:id`, `/health`, `/runs`, `/cost`, `/activity`, `/proposals`; `POST /ui/…` | owner (agents: read-only pages) | The panel: an overview, then one page per section (`/runs`, `/activity` and `/proposals` are the Runs, Changes and Proposals tabs of one Log section), rendered from the reads above, and its same-origin form posts.                                                                               |

`from`/`to` are inclusive calendar days (YYYY-MM-DD, UTC); a bad one, or `to` before `from`, is 400 `invalid_period`. Either may be left out to leave that end open; on `/v1/cost` an open start is the first month anything was filed and an open end is this month.

Targets: `global`, `<stage>`, `<policy>`, `<entry>.<knob>`, `<stage>@<dim>=<value>` (e.g.
`ingest@source=smartrecruiters`; value `inherit` clears an override, and an override at the stage's
top mode caps nothing, so it is stored as no override — setting one where none exists is a no-op).
Every registry dimension is also a `/v1/gate` query parameter.

RPC (`ControlRpc`, for a service binding): `gate(stage, dims?)`, `recordRun(run)`,
`trip(stage, reason, detail?)`. A binding passes `props = { name = "<registry runtime id>" }`: its audit
label and the stages it may record and trip.

## Storage and the fail-closed rules

D1 tables: `state` (one row per target), `change_log` (append-only), `proposal`, `ledger`, `statement` (the billing mailbox). Every
state change and its change-log row are written in the **same `db.batch()`** (one transaction), and
both statements are conditional on the state still holding the value the caller was classified
against — so a concurrent trip can't turn an agent's safe "on → shadow" into an unapproved
"off → shadow".

Fail-closed (owner decision, ingest included): a **missing row** reads as the registry default; an
**unrecognised value** reads as `off` (a knob: its least risky bound, but a number outside its range
takes the nearest bound); an **unreachable store** means the caller skips its tick (the gate clients
of later slices; this Worker answers 5xx).

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

## Billing mailbox (the Cost page)

The Cost page shows what each vendor actually charged, read from their own invoice emails (owner decision
2026-10-10: statements, not a maintained price table or estimates). The owner's Gmail filter forwards
vendor invoices to `BILLING_ADDRESS` (`billing@opusfinder.ai`, wrangler `[vars]`); Cloudflare Email Routing
on `opusfinder.ai` sends that address to this Worker's `email()` handler, which records one `statement`
row per email:

- **Only what the owner forwarded.** The gate decides once, before anything is read:
  - a message must carry exactly one From address (with two, the gate and the parser could each see a
    different one);
  - mail whose envelope sender (`message.from`) is an `OWNER_EMAILS` address is an owner forward (a Gmail
    filter forward arrives as `owner+caf_=…@gmail.com`, so the `+tag` and Gmail dots are ignored; a hand
    forward arrives as the owner's own address — verified 2026-10-10);
  - otherwise, mail whose single From is exactly Gmail's `forwarding-noreply@google.com` is filed as Gmail's
    forwarding confirmation and nothing else: never read by the model, never counted;
  - everything else is refused at the SMTP stage (no row, no model read; the Worker logs the domain only).

  The envelope sender is SMTP's unauthenticated MAIL FROM, and Cloudflare admits mail that passes SPF _or_
  carries any valid DKIM signature, so someone who knows the owner's address could forge it. Until the gate
  checks authentication, nothing read from an email counts by itself (below). **Shadow:** each accepted
  email's SPF / DKIM / DMARC / ARC verdicts are stored in `statement.auth` (and logged), one entry per
  header in header order, labelled with the server that wrote it, domains only. Any hop, and the sender,
  can add these headers, so a gate must read only the topmost entry Cloudflare wrote, never match a
  substring of the column. UNVERIFIED until the first filter forward (Cloudflare's, ~23rd): whether
  Cloudflare writes such a header where the Worker sees it at all; if not, the gate needs another basis.
  Either way the gate proves only who forwarded the mail, not who wrote it: anyone can send mail a broad
  filter forwards (e.g. another merchant's Stripe invoice), so a filter forward should count by itself only
  when its From is also a known in-scope vendor sender.

- **Read by a model.** Workers AI (`[ai]` binding, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` in JSON
  mode) reads vendor, kind, total, currency, charge date, service period and invoice number (the invoice's,
  over a receipt's); it gets both the plain-text and HTML parts, and when the body doesn't settle it, the
  attached PDF (via `toMarkdown`). Every field is validated (real calendar dates, a day of timezone slack);
  the email is untrusted text and the model has no tools.
- **Counted by the owner.** Every forward lands in `review` (or `duplicate`, below), pre-filled with what
  the model read, for the owner to count (correcting the amount, date and service period as needed) or
  exclude. A note says what's doubtful: no total, no vendor, no charge date on a hand forward (its own
  date is the forward's, not the invoice's), a currency other than USD, a failed model call, an
  unparseable or oversized (> 10 MiB) email, or mail the model doesn't see a bill in. Only owner forwards
  reach the model, so it never drops one. `ignored` is only for Gmail's confirmation, which can't be
  counted (the server refuses, whatever the row's status). An agent's hand entry also waits in `review`;
  the owner's counts at once.
- **Caps.** Per UTC day: 100 owner forwards and, apart from them, 5 Gmail confirmations (anyone can write
  that From header, so junk confirmations can't use up the owner's quota); past either, mail is refused at
  the SMTP stage. Past 50 forwards in a day the rest wait in `review` unread (each read is at most two model
  calls and one PDF conversion). How Email Routing answers when the handler itself throws (e.g. a D1
  outage) isn't documented: the email may be lost, so check the Email Routing activity log after an outage.
- **Counted once, mostly.** A redelivered email (same `Message-ID`) is dropped. A second email for a
  charge already counted or still in `review` — same vendor (compared without case, punctuation or legal
  suffixes: "Neon, LLC" is "Neon") and invoice number (without case or punctuation: "#inv-7" is "INV7"),
  or, when either has no number, same vendor and amount within 3 days — is stored as `duplicate`.
  Different invoice numbers never merge, so the filter should still forward one email per charge.
- **Filed by month.** Under the service period the invoice states, else the charge date. Prepaid credits
  (cash, not usage) go by the charge date, and so does a period the model reads as starting after tomorrow
  (billed in advance) until the owner enters it when counting. The month view groups vendor spellings into
  one line.
- **Gmail's forwarding confirmation** (code and/or link) is shown on the Cost page to the owner only;
  agents see neither the code nor the subject that repeats it.
- Mail for any address other than `BILLING_ADDRESS` is rejected, and all mail while it is unset.

**Scope** (owner, 2026-10-10): only what it costs to run opusfinder — Neon, Cloudflare (Workers Paid and
the `opusfinder.ai` domain; not the account's other domains), Voyage AI, OpenRouter (the product's LLM
calls), and Vercel if it bills again. Personal subscriptions (Claude Max) are out. The Gmail filter is
where the scope is set; anything that slips through is excluded on the Cost page.

Owner setup, once (notes in `research/rnd/email-forwarding-setup.md`):

1. Apply the migrations and deploy (see "Shipping a change").
2. Email Routing on `opusfinder.ai` (enabled 2026-10-10): Routing rules → custom address
   `billing@opusfinder.ai` → action **Send to a Worker** → `opusfinder-control`. Make the rule in the
   dashboard: Wrangler ≥ 4.113 can own routing rules through an `addresses` field in the Worker config, but
   this repo's Wrangler is older, and using both makes the next deploy report a takeover conflict.
3. Gmail → Settings → Forwarding → add `billing@opusfinder.ai`. Gmail's confirmation mail appears on the
   Cost page under "Not counted", with its link (clickable, owner only) and code if it has one.
4. A Gmail filter forwarding one email per charge from each in-scope vendor. It affects new mail only: forward
   older invoices by hand with plain **Forward** (the mailbox reads the inlined original; an invoice forwarded
   as an attachment isn't read and lands in review), or add them on the Cost page.

## Shipping a change

When a PR adds a migration under `apps/control/migrations/`, apply it to production **before** deploying the
Worker, from `apps/control`:

```bash
pnpm exec wrangler d1 migrations apply opusfinder-control --remote   # lists, then applies, only the new ones
pnpm exec wrangler deploy
```

A deploy without its migration still serves, but the queries the migration was written for run without
their indexes, or fail outright when a table or column is missing.

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
file per field; `OPUSFINDER_CTL_CONFIG` names another file.)

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
  reach the `workers.dev` hostname (add it to the sandbox network allowlist). Behind the sandbox's
  proxy, Node's fetch needs `NODE_USE_ENV_PROXY=1`.
- Don't grant the browser extension the panel's hostname.

**Break-glass** (Access locks you out): edit D1 directly as yourself and log it by hand —

```bash
pnpm exec wrangler d1 execute opusfinder-control --remote --command "UPDATE state SET value = 'off', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = 'break-glass:owner' WHERE key = 'embed'; INSERT INTO change_log (at, actor_role, actor_name, target, from_value, to_value, reason, channel) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'break-glass', 'owner', 'embed', 'on', 'off', 'break-glass: Access lockout', 'break-glass')"
```

## Runtimes wired

**The scrapers Worker (`opusfinder-scrapers`), in SHADOW.** Its `CONTROL` service binding
(`apps/scrapers/wrangler.toml`; props `name` is the registry's runtime id, so its rows read
`runtime:cf:opusfinder-scrapers`) reaches `ControlRpc`. Every `ingest` and `discover` tick reads its gate
at the start (waiting at most ~2 s), runs exactly as before whatever the gate said, and writes one ledger
row at the end, in `ctx.waitUntil`:

- **Log:** one line per tick — `control gate ingest: on (shadow: not enforced)`,
  `control gate ingest: would skip: off (by <who>: <reason>)` or
  `control gate ingest: would skip: control plane unreadable (<reason>)` (also for a mode the stage
  doesn't have). While the stage is on, `control gate ingest: would skip source=workable (overrides)`
  names the slices its overrides turn off. And
  `control gate ingest: settings differ, not enforced: <key> <gate> (gate) vs <value> (in use), …` when
  the gate's knobs or policies differ from what the tick runs with: `boardsPerTick` vs the resolved
  `INGEST_LIMIT`; `limit` / `reprobeLimit` vs the Worker's constants; `close` / `stale_sweep` vs
  `LIFECYCLE_CLOSE_ENFORCE` / `STALE_SWEEP`; `stale_sweep.ttlDays` vs `STALE_SWEEP_TTL_DAYS`.
- **Ledger row:** `ok`, `partial` (the run budget stopped the run early) or `error` (the tick threw,
  recorded before the re-throw, or no ingest board succeeded and at least one failed); the gate mode it
  read (null when unreadable); the Worker's own start/finish clock; `cf.wall_ms`; a one-line `detail` (for
  a thrown tick, the watchdog's `describeDbError` text: a failed query's Postgres reason first, never its
  params); and for ingest the work counts `ingest.boards` (rate-limit-skipped boards included),
  `ingest.boards_failed`, `ingest.boards_rate_limited` and `ingest.jobs_changed`.

A control-plane failure (slow, unbound, refusing the row) is logged and never fails a tick, changes its
outcome or skips a watchdog ping. `cf.subrequests` and `neon.awake_s` stay declared but unsent: the
Worker has no subrequest counter, and Neon awake time is an estimate for the cost slice.

**Deploy order:** when the registry gains a unit a runtime sends, deploy THIS Worker first; until then
`recordRun` refuses those rows (400 `invalid_run`, logged by the runtime, nothing breaks).

## Known gaps (slice 1)

- No runtime obeys the gate yet: flipping a switch here changes the record (and the scrapers Worker's
  shadow log line), not behaviour. The deployed env vars (`INGEST_LIMIT`, `LIFECYCLE_CLOSE_ENFORCE`,
  `STALE_SWEEP*`, …) still rule. Inngest doesn't read the gate or write ledger rows.
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
  - the `close` and `stale_sweep` initial modes and `stale_sweep.ttlDays`'s default, against the
    scrapers Worker's `wrangler.toml` vars;
  - the `health.*` check ids, threshold defaults and env var names.

  **Not pinned** (keep both sides in step by hand): the `live_integration` cron
  (`.github/workflows/live-integration.yml`), the `discover` knobs' min/max, every `expect` period
  (update it with its cron), `embed.pagesPerRun`, `digest.topK` and `alerts.cooldownH`.

- Approvals don't force a fresh Access login (feasibility unverified).
- Proposals expire lazily (read-time), with no notification.

### Follow-ups

- Enforce the scrapers gate once its shadow lines have read right on real ticks for a few days: `off`
  or an unreadable store skips the tick (a `skipped` ledger row), and the gate's knobs replace
  `INGEST_LIMIT` and the discovery constants. Its own owner-approved step, like every shadow → enforce.
- Wire the Inngest stages (`embed`, `alerts`, `digest`) the same way, in shadow first.
- Pin each value listed as **not pinned** above.
- Move the scrapers Worker's schedule and limit constants into a sibling module (e.g.
  `apps/scrapers/src/schedule.ts`; workerd rejects only the main module's `export const`), so
  `dispatch.test.ts` imports them instead of keeping literal copies.
- Merge the duplicated test scaffolding: the scrapers Worker's `dispatch.test.ts` and
  `control-registry.test.ts` each mock the pipelines and drive `scheduled()`, and the Inngest
  `crons.test.ts` and `control-registry.test.ts` each build the functions to read their triggers.
- Add a test that derives each stage's `expect.everyMin` from the shape of its cron.
