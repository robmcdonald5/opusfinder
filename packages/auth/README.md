# @opusfinder/auth

Backend/server-only user identity (Phase 9.5): **Better Auth** (email+password) over the Neon/Drizzle
adapter, plus the shared user-creation service the CLI now and the Phase-12 SvelteKit action later both
call. **No UI** — the HTTP handler, auth-client, and forms land in Phase 12.

> **Worker invariant.** Better Auth crashes at import under Cloudflare `nodejs_compat` (#6665), so this
> package must NEVER enter the `apps/scrapers` Worker bundle. The scraper/digest Worker reads Neon
> directly as a trusted process and never imports `@opusfinder/auth`. `pnpm guard:worker` enforces it.

## What's here

- `src/auth.ts` — `createAuth(authDb, { secret, baseURL })`: the Better Auth instance over the Drizzle
  adapter. `authDb` MUST be the **neon-serverless** `createAuthDb` (`@opusfinder/db/auth-client`) —
  the adapter's `transaction` config defaults to false in better-auth 1.6.x, so `signUpEmail` runs
  its inserts sequentially today, but the tx-capable driver is kept so enabling adapter transactions
  (or a future better-auth default flip) can't hit neon-http's "No transactions support" (#4747).
  Config: `generateId: "uuid"`, `autoSignIn: false`, `requireEmailVerification: false`.
- `src/service.ts` — `createUserWithPreferences(db, auth, input)` (signUpEmail → seed-only `emailVerified`
  flip → seed `user_preferences` with a random unsubscribe token); `getOrCreateUserByEmail(db, auth,
email)` (the CV-ingest path — creates a verified user with a throwaway random password, idempotent on
  normalized email); `findUserIdByEmail`.
- `src/env.ts` — node-only `getAuthSecret()` / `getAuthBaseURL()` behind the `./env` subpath (never
  bundled into the Worker, same discipline as `@opusfinder/storage/env`).
- `scripts/` — `user:create` / `user:set-prefs` / `user:list` CLIs. (The old `test:auth` and
  `test:create-user` smokes moved to co-located Vitest: `src/auth.integration.test.ts` — the
  `AUTH_LIVE_TEST=1` neon-serverless live gate — and `src/service.integration.test.ts` on PGlite;
  wiring/env pins live in `src/auth.test.ts` + `src/env.test.ts`, prefs flag-parsing in
  `src/cli-utils.test.ts` + `src/prefs-flags.test.ts`.)
- `better-auth.ts` — the entrypoint `pnpm dlx @better-auth/cli generate` introspects to emit the schema.

The `user` / `session` / `account` / `verification` + `user_preferences` tables live in the unified
`@opusfinder/db` schema and migrations (`pnpm db:migrate`).

## Setup

Put a self-generated signing secret in `packages/auth/.env` (gitignored — never committed):

```sh
# BETTER_AUTH_SECRET=...                 (openssl rand -base64 32)
# BETTER_AUTH_URL=http://localhost:5173  (optional; this is the default pre-UI)
```

## CLIs

```sh
pnpm user:create --email me@example.com --password "<pw>" --location-mode remote_only --min-yoe 2 --max-yoe 5 --cadence daily
pnpm user:set-prefs --email me@example.com --max-salary 180000 --dealbreakers crypto,gambling --min-salary clear
pnpm user:list
```
