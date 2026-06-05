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
  `signUpEmail` wraps the `user`+`account` inserts in a transaction the neon-http driver can't run
  (#4747). Config: `generateId: "uuid"`, `autoSignIn: false`, `requireEmailVerification: false`.
- `src/service.ts` — `createUserWithProfile(db, auth, input)` (signUpEmail → seed-only `emailVerified`
  flip → seed `user_preferences` with a random unsubscribe token); `getOrCreateUserByEmail(db, auth,
email)` (the CV-ingest path — creates a verified user with a throwaway random password, idempotent on
  normalized email); `findUserByEmail`.
- `src/env.ts` — node-only `getAuthSecret()` / `getAuthBaseURL()` behind the `./env` subpath (never
  bundled into the Worker, same discipline as `@opusfinder/storage/env`).
- `scripts/` — `user:create` / `user:set-prefs` / `user:list` CLIs, plus `test:auth` (driver/B1 probe)
  and `test:create-user` (end-to-end, self-cleaning) smokes.
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
pnpm user:create --email me@example.com --password "<pw>" --remote false --cadence daily
pnpm user:set-prefs --email me@example.com --min-salary 120000 --cadence weekly
pnpm user:list
```
