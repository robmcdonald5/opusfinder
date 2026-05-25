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
