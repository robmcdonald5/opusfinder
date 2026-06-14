# @opusfinder/shared

Cross-package types and validators, plus a few small cross-cutting runtime helpers.
Exports the raw `src/index.ts` barrel (types + validators, dependency-free), a
`@opusfinder/shared/script` subpath for the CLI runner (dependency-free), a
`@opusfinder/shared/env` subpath for env loading (depends on `dotenv`), a
`@opusfinder/shared/async` subpath for the shared retry/backoff (dependency-free, Worker-forward),
and a `@opusfinder/shared/userid` subpath for deterministic user-id minting (depends on
`node:crypto`, Node-only — deliberately kept off the barrel so `src/index.ts` stays free of `node:`
imports and bundles cleanly into the `nodejs_compat`-less scrapers Worker).

## Brand types

`CompanySlug` and `JobId` are **branded strings** — nominal types that are still
plain strings at runtime but can't be assigned from a raw `string` without going
through a validator. This makes "an unvalidated slug" and "a validated slug"
distinct types the compiler enforces.

Construct them with the validators:

- `companySlug(value)` → `CompanySlug`
- `jobId(value)` → `JobId`

Both trim and throw on violation.

## Universal-floor-only validation

`companySlug()` enforces only the **universal slug floor** — invariants true for
_every_ ATS: trimmed, non-empty, and URL-path-safe (`/^[A-Za-z0-9._-]+$/`, so a
slug can be dropped into a request path without injection).

It deliberately does **not** canonicalize. In particular **mixed case is
allowed** and `_`/`.` are permitted, because slug shape differs across platforms:
Greenhouse / Lever / Workable tokens are lowercase, but SmartRecruiters company
IDs are **case-sensitive** — lowercasing them breaks the lookup. So per-ATS
canonicalization (casing, etc.) is **deferred to the per-source adapters**
(`SourceAdapter.normalizeSlug`, Phase 6), which produce the platform-canonical
form and then call `companySlug()` to enforce the floor. Keep platform-specific
rules on the adapter, never here.

## Escape hatches

`unsafeCompanySlug(value)` / `unsafeJobId(value)` brand a value **without validating** — only for
already-trusted values, e.g. rows read back from the DB.

## Normalized job shape

`NormalizedJob` is the cross-source normalization contract — the single flat,
source-agnostic shape every ATS adapter maps into. In-memory only in Phase 1
(Greenhouse); persisted to Neon in Phase 2.

Fields: `source` (`SourceName`), `externalId` (branded `JobId`), `title`,
`companySlug` (branded, platform-canonical), `locations` (raw ATS strings, kept
whole — no parsing in Phase 1), `remote` (heuristic, inferred from the location
text; "Hybrid" → `false`), `descriptionText` (HTML entities decoded → tags
stripped → whitespace collapsed), `applyUrl`, `postedAt` (`Date | null`), and
`raw` (the untouched source object, typed `unknown`). Per-field rationale lives
in `src/index.ts` comments.

The type is intentionally **not** generic over the raw payload, and there is
**no adapter interface here** — that abstraction was extracted in Phase 6 (it
lives in `@opusfinder/sources` as `SourceAdapter`), from 2–3 concrete adapters,
not designed up front.

`SourceName` is the union of ATS names — `"greenhouse" | "lever" | "ashby" |
"workable" | "smartrecruiters"` (the five Launch ATS; Phase 1 shipped Greenhouse,
Phase 6 added the other four). Kept a union rather than `string` so a typo is a
compile error and the `jobs.source` column / the Phase 6 source→adapter registry
(`Record<SourceName, SourceAdapter>`) stay exhaustive — a missing adapter is a
compile error.

## Type guards

`isRecord(value): value is Record<string, unknown>` narrows an `unknown` to a non-null
object — the floor check before reading properties off an untrusted JSON value (e.g. an
ATS response, or an embedding-provider reply). Centralized here so each parser doesn't
re-define it.

## Embedding-text composition

`composeEmbeddingText(parts)` drops blank parts and joins the rest with a blank line.
It is the single definition of how embedding input is composed and of what "no embeddable
content" means (the result is `""` iff every part is blank). Shared by `jobEmbeddingText`
(@opusfinder/db), `composeProfileText` (below), and the dataset validator, so the "empty"
notion has one source of truth. Lives here (not in @opusfinder/embeddings) so the dataset
loader can reuse it without pulling the embeddings/db stack onto the load path.

`StructuredProfile` (`{ summary, skills[], targetRoles[] }`) is the semantic CV profile — the
PII-free shape Phase 9 CV ingestion stores in `user_profiles.structured` and the **same** shape
`EvalProfile` extends, so the eval and production profiles can't drift. `composeProfileText(profile)`
composes its embedding "query" text (summary, then `Skills: …`, then `Target roles: …`, via
`composeEmbeddingText`) — the single source of truth for the profile vector, mirroring
`jobEmbeddingText` on the document side. Both the eval harness and the Phase-10 reranker
(`@opusfinder/rerank`'s `buildRerankSystem`) call it directly, so the reranker reasons over the same
profile representation retrieval uses.
Contact info / addresses are intentionally omitted (no job-alignment signal); `preferences` is not
part of the vector (it comes from the Phase-12 form, feeds the deterministic filter).

## Script runner

`runScript(label, main)` (from `@opusfinder/shared/script`) is the shared failure
tail for every tsx CLI entry point. It runs `main`, and on a thrown error logs
`` `${label} failed: <message>` `` and sets `process.exitCode = 1`.

It deliberately never calls `process.exit()`: an abrupt exit while an undici /
neon-http socket handle is still closing trips a libuv assertion on Windows
(`UV_HANDLE_CLOSING`). Setting `exitCode` lets the event loop drain those handles
and then exit cleanly. Centralized here so the teardown contract lives in code,
not in a comment re-pasted into each script.

```ts
import { runScript } from "@opusfinder/shared/script";

await runScript("Backfill", main);
```

## Async / backoff

`backoff(attempt, retryAfter?)` (from `@opusfinder/shared/async`) is the shared retry sleep for the
repo's resilient fetch loops — exponential (`2s · 2^attempt`, capped at 15s) + jitter, with an HTTP
`Retry-After` override (delta-seconds or HTTP-date, capped at 30s; `Retry-After: 0` is honored as
~0 ms rather than dropped). **Extracted in Phase 7** from `@opusfinder/sources`' run-adapter so the
ingestion list-fetch and the discovery prober share ONE definition. Pure + Worker-forward (global
`setTimeout` / `Math.random` / `Date`, no Node-only APIs and no `process.env` reads).

`sleep(ms)` also lives in `@opusfinder/shared/async` (lifted in Phase 8); it backs `runIngestion`'s
inter-board pacing and discovery's `probe.ts`.

## Env loading

`@opusfinder/shared/env` centralizes the dotenv bootstrap each package's `env.ts`
used to copy:

- `loadPackageEnv(import.meta.url)` loads `packages/<pkg>/.env` resolved relative to
  the calling `src/` module (not the cwd), so cross-package callers find it however
  they're invoked. (A file at the package root, e.g. `drizzle.config.ts`, must not use
  it — it would resolve one directory too high.)
- `requireEnv({ name, notSet, validate?, prefix? })` returns a getter that trims, throws
  the friendly `notSet` message if absent, runs an optional hard `validate` (e.g. a URL
  scheme check), and emits an optional soft `prefix` warning. Errors and warnings echo
  only non-sensitive shape (presence, length, scheme/prefix) — never the value.

```ts
import { loadPackageEnv, requireEnv } from "@opusfinder/shared/env";

loadPackageEnv(import.meta.url);

export const getVoyageApiKey = requireEnv({
  name: "VOYAGE_API_KEY",
  notSet: "VOYAGE_API_KEY is not set. Paste it into packages/embeddings/.env ...",
  prefix: "pa-",
});
```

## User identity

`UserId` is a **branded string** (a UUID). As of **Phase 9.5**, real user ids come from the Better Auth
`user` table (`@opusfinder/auth`) — a random `user.id`. The deterministic `mintUserId(email)` (UUIDv5
over a fixed namespace + normalized email, in the node-only `@opusfinder/shared/userid` subpath) is
**retired from the live path**: `ingest-cv` / `profiles-restructure` now resolve a real `user.id` via
`getOrCreateUserByEmail` / `findUserByEmail`. `mintUserId` is kept ONLY as a deterministic id source for
the offline `test-ingest` smoke and is locked by the golden-vector test
(`pnpm --filter @opusfinder/shared test:userid`); email-derived ids are not reintroduced on the live
path (email is PII → reversible ids are a debt being paid down). It stays on its own subpath because it
imports `node:crypto` — keeping the `src/index.ts` barrel `node:`-free so it bundles into the
`nodejs_compat`-less scrapers Worker (same discipline as `@opusfinder/shared/env`).

## User preferences + unsubscribe token (Phase 9.5, extended in F3)

`UserPreferences` is the node-free, user-SETTABLE preferences contract — `{ locationMode, locations[],
minSalary, maxSalary, yoeMin, yoeMax, recencyDays, exclusions[], dealbreakers[], digestCadence,
digestEnabled }` — the shape both the `user_preferences` repo (`@opusfinder/db`) and the `user:set-prefs` CLI
write, and the future SvelteKit settings form will reuse. The deterministic-filter fields
(`locationMode`/`locations`/`recencyDays`/`exclusions`/`dealbreakers`) feed digest retrieval; the
judgment-context fields (`yoeMin`/`yoeMax`/`minSalary`/`maxSalary`/`dealbreakers`) feed the rerank + synthesis
prompt via `composePromptPrefs` (Phase F3 — salary/YoE are stored + soft-prompt now, salary becomes a hard
filter in F4). The YoE band is the declared-level signal (the too-senior fix); a categorical `TargetLevel`
was considered and dropped as redundant/ambiguous (YoE is the cleaner objective gate). `DigestCadence` is
`"daily" | "weekly" | "monthly"`; `LocationMode` is `"any" | "remote_only" | "onsite_only"` (F3 — subsumes
the former `remoteOk` boolean). Pipeline-managed delivery STATE (unsubscribe token, bounce status,
suppression, last-sent markers) is deliberately NOT in this contract.

`generateUnsubscribeToken()` returns a cryptographically-random, URL-safe token (64-hex / 256-bit) via
Web Crypto — node-free, so it lives on the barrel, not in `./userid`. Generated once at user creation and
stored on `user_preferences.unsubscribe_token` for the RFC 8058 one-click List-Unsubscribe header
(Phase 12 — the token stays dormant through Phase 11's lean send, which ships no unsubscribe
link/headers); never email-derived. Locked by `pnpm --filter @opusfinder/shared test:token`.

## Digest enums (Phase 10)

`DigestTrigger` (`"manual" | "cron"`) and `DigestFeedback`
(`"saved" | "applied" | "dismissed" | "not_interested"`) are the Phase-10 digest enums consumed by the
db schema — `digest_runs.trigger` and the nullable `digest_items.feedback` column (`@opusfinder/db`).
Kept here (with `DigestCadence`) so the schema, the trigger CLI, and the future Phase-12 feedback UI all
agree on the literals.
