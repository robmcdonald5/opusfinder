# @opusfinder/web

The SvelteKit app — the production runtime host (Phase 12). No React/JSX; this project uses Svelte.

## 12a — headless runtime (current)

A minimal SvelteKit skeleton with two routes: the **Inngest serve endpoint**
(`src/routes/api/inngest/+server.ts`, `inngest/sveltekit`) and a **`/api/health` endpoint** (over the
pure `checkHealth` core). The serve endpoint hosts the Phase-10 digest functions, the daily
cadence cron (`0 13 * * *`, `makeCadenceOrchestrator`), and the F8 embedding backfill drain
(`0 4 * * *`) on Inngest Cloud — **deployed live on Vercel + Inngest Cloud**. There are **no
user-facing pages yet** — friends are onboarded via the CLIs (`pnpm user:create` → `pnpm ingest-cv` → `pnpm user:set-prefs`).

- **Serverless Node, not edge** (`svelte.config.js`, adapter-vercel): the deps reach `@anthropic-ai/sdk` +
  `@neondatabase/serverless`. `maxDuration` 300s. Set the Vercel project's Node version to **22.x**.
- **Vite bundles the `@opusfinder/*` workspace packages** (`vite.config.ts` `ssr.noExternal`) because they
  publish raw TS source.
- **Deploy notes (owner):** the Inngest Vercel integration auto-provisions `INNGEST_SIGNING_KEY` /
  `INNGEST_EVENT_KEY` and syncs functions every deploy — don't set those by hand; leave `INNGEST_DEV`
  unset; turn off Deployment Protection for `/api/inngest`; install/build at the repo root (monorepo).

## 12b — the UI (deferred)

Auth pages, the preferences + CV-upload forms, digest history + feedback, the interactive dev panel — added
on top of this runtime, no rework.

## Commands

```sh
pnpm --filter @opusfinder/web dev      # local dev server
pnpm --filter @opusfinder/web check    # svelte-kit sync + svelte-check (type-check)
pnpm --filter @opusfinder/web build    # production build (adapter-vercel output)
```
