# @opusfinder/shared

Cross-package types and validators, plus two small cross-cutting runtime helpers.
Exports the raw `src/index.ts` barrel (types + validators, dependency-free), a
`@opusfinder/shared/script` subpath for the CLI runner (dependency-free), and a
`@opusfinder/shared/env` subpath for env loading (depends on `dotenv`).

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

`unsafeCompanySlug(value)` / `unsafeJobId(value)` brand a value **without
validating** — only for already-trusted values, e.g. rows read back from the DB.

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
(@opusfinder/db), `profileEmbeddingText` (eval), and the dataset validator, so the "empty"
notion has one source of truth. Lives here (not in @opusfinder/embeddings) so the dataset
loader can reuse it without pulling the embeddings/db stack onto the load path.

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
