# @opusfinder/email

The Phase-11 **digest email**: a pure, deterministic render (escaped HTML + a plain-text part) and a
thin **Resend** transport (idempotency-keyed send, delivery-state read; the send PERMIT is enforced
UPSTREAM — the DB-native `user_preferences.digest_approved_at` gate, not here). The digest pipeline
(`@opusfinder/inngest`) calls it through the `DigestDeps.email` seam after `persist`; nothing else sends
mail. **Node/server runtime only** — deny-listed from the scrapers Worker (`pnpm guard:worker`), like
`better-auth` and `inngest` before it. **Phase F6** adds one non-digest send — `sendHealthAlert` (operator
health alerts to a dedicated `ALERT_TO` — the owner as operator, not a product user).

## Why render is split from transport

`renderDigestEmail(payload)` is a PURE function — payload in, `{subject, html, text}` out, no I/O, no
env, **no clock** — so it previews and smoke-tests with zero credentials, and the end-of-phase
"Resend vs alternative" evaluation swaps `transport.ts` (the ONLY `resend` import), not a package.
The Resend client is constructed lazily on the first real call (the `packages/llm` provider
discipline): importing the barrel never requires a key.

## Two non-negotiables baked into the render

- **Hostile input is neutralized.** Titles/reasons/slugs are scraped ATS content rendered into an
  inbox: EVERY interpolated field goes through `escapeHtml` (`& < > " '`), and `applyUrl` is
  scheme-gated to `http:`/`https:` — a scraped `javascript:` URL degrades to inert escaped text,
  never an href. The preview fixture carries a live attack payload so a regression is visible.
- **The output is byte-deterministic per payload.** Resend's `Idempotency-Key` replay (24h window)
  rejects a CHANGED payload with 409 `invalid_idempotent_request`, so a retried send step must
  re-render identical bytes: the only date shown is `payload.createdAt` (UTC), and the module has no
  `Date.now()`/randomness. The stub smoke renders twice and asserts byte-equality.

## Public surface (`src/index.ts`)

- `renderDigestEmail(payload: DigestEmailPayload): RenderedEmail` — the pure render. The payload type
  is a type-only import from `@opusfinder/db/repos` (no db code at runtime).
- `sendDigestEmail(payload)` → `{ emailId }`. A PURE transport — the send PERMIT is enforced UPSTREAM (the
  DB-native `digest_approved_at` gate: checked at recipient resolution + the digest load step + re-asserted
  at the send boundary in `deliverDigestEmail`), NOT here; this just renders, then sends with
  `Idempotency-Key: digest/<digestId>`. API errors become thrown Errors echoing **name + status code
  only** (Resend's `error.message` can quote the recipient address) so the Inngest step owns retries.
- `getEmailLastEvent(emailId)` — `GET /emails/:id` → `last_event` passthrough. The event→status
  POLICY lives in `@opusfinder/inngest` (`mapDeliveryEvent`), not here.
- `emailIdempotencyKey(digestId)` — the ONE key definition (the `synthId` discipline), exported so
  the smoke locks its shape.
- `sendHealthAlert(subject, text)` → `{ emailId }` (Phase F6) — a plain-text operator alert for the `pnpm health`
  CLI. Reuses the lazy SEND client (`RESEND_API_KEY`) + `EMAIL_FROM`, but goes to a dedicated `ALERT_TO` operator
  address — a **DEDICATED operator address** (the owner as operator) so the alert can never be the silently-broken thing F6 exists to
  kill. **No idempotency key** (each run's verdict is its own event), shape-only errors (name + status).

## Env (`./env` subpath — `packages/email/.env`, gitignored)

| Var                   | Required              | Notes                                                                                                                                             |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`      | yes (at send time)    | the SEND key — a sending-only key suffices (least privilege); starts `re_`, soft prefix check, shape-only echoes                                  |
| `RESEND_API_KEY_FULL` | yes (at poll time)    | the READ key for the delivery poll — must be FULL access (`GET /emails/:id` 401s `restricted_api_key` on a sending-only key); retires with P12 webhooks |
| `EMAIL_FROM`          | yes (at send time)    | verified sender, display-name form: `opusfinder digest <digest@send.opusfinder.ai>`                                                               |
| `ALERT_TO`            | yes (at alert time)   | Phase-F6 operator alert recipient (`sendHealthAlert`) — a DEDICATED operator address (operator, not product user); fail-loud (`requireEnv` throws if unset, so `pnpm health` exits non-zero rather than dropping an alert) |

> The digest **send permit** is no longer an env var — it moved to the DB-native, fail-closed
> `user_preferences.digest_approved_at` gate (migration 0022). Grant with `pnpm user:approve --email <addr>`.

## Scripts

- `pnpm email:preview` (root alias) — renders a built-in fixture (including the hostile item) to
  `packages/email/email-preview.html` + prints the text part. Zero creds, zero DB, zero network.
- The behavioral smoke lives with its consumer: `pnpm --filter @opusfinder/inngest test:digest-email`.

## Phase 12 (what changes here)

Webhooks replace the bounded poll (and carry bounce subtypes), the unsubscribe endpoint + RFC 8058
headers activate `user_preferences.unsubscribe_token` (the Phase-11 footer deliberately renders NO
unsubscribe link — a dead link is worse than none at one-recipient volume), the `digest_approved_at` operator permit either retires (drop the one
enrollment predicate) or becomes an operator-override lane once a real signup makes `email_verified` a true
consent signal, Better Auth's `sendVerificationEmail` wires to this package, and the template gets its
design pass with the frontend.
