# @opusfinder/shared

Cross-package types and validators. No runtime dependencies; exports raw
`src/index.ts`.

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
**no adapter interface here** — that abstraction is extracted in Phase 6 from
2–3 concrete adapters, not designed up front.

`SourceName` is the union of ATS names (`"greenhouse"` only in Phase 1; one new
member per adapter as they land). Kept a union rather than `string` so a typo is
a compile error and the Phase 2 `jobs.source` column / Phase 6 source registry
stay exhaustive.
