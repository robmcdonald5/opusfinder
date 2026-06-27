# @opusfinder/db

Drizzle ORM over Neon Postgres, using the **neon-http** driver
(`@neondatabase/serverless`). HTTP/fetch-based, no TCP sockets — so the same
client runs in Node today and in Cloudflare Workers (Phase 8). The package
exports raw `.ts` (no build step / no `dist`): `createDb(connectionString)`
returns a Drizzle client. Phase 2 added subpath exports alongside it:
`@opusfinder/db/repos` (`upsertCompany` / `upsertJobs` / `listCompanies`; the Phase-4 embedding repo —
`backfillJobEmbeddings` / `nearestJobs` / `jobsNeedingEmbedding` / `writeJobEmbeddings` /
`jobEmbeddingText`; the Phase-7 discovery repo — `startRun` / `finishRun` / `failStaleRuns` /
`listCompaniesForReprobe` / `listCompanyStates` / `markProbeResult` / `markProbed` / `deactivateStale`;
the Phase-9 profiles repo — `insertCvFile` / `patchCvFileExtracted` / `markCvFileFailed` /
`upsertUserProfile` / `getProfileTextKey`; and the Phase-9.5 preferences repo — `getPreferences` /
`getOrCreatePreferences` / `updatePreferences`; the Phase-10 retrieval repo —
`retrieveCandidatesForProfile`; and the Phase-10 digests repo — `listDigestRecipients` (gained an
opt-in `cadenceDue` cadence-window predicate — daily 20h / weekly 6d / monthly 28d off
`last_digest_sent_at`; default no-filter, set true only on a cron run) /
`alreadyShownJobIds` / `startDigestRun` / `finishDigestRun` / `insertDigest` / `insertDigestItems` /
`deleteUserDigestForRun` / `getLatestDigestForUser` / `markDigestConsidered` (the Phase-12a no-send
backoff — stamps `last_digest_sent_at` on the skip paths so a due-but-empty user doesn't re-run the paid
pipeline each daily tick) (plus `getProfileForDigest` on the profiles repo); and the Phase-F2 lifecycle repo —
`sweepLifecycle` / `closeJobsForCompanies` / `closeJobsByIds` / `ABSENCE_CLOSE_THRESHOLD` (the first writers of
`lifecycle_state='closed'`), plus `getDigestApplyTargets` / `dropDigestItemsAndRecount` on the digests repo
(Arm C apply-URL read + dead-link drop); and the Phase-F1 de-dup spine — `alreadyShownSignatures` on the digests
repo (the signature sibling of `alreadyShownJobIds`) + `collapseBySignature` on the retrieval repo (the exported
same-signature display-collapse), with `retrieveCandidatesForProfile` gaining an `excludeSignatures` clause)
and `@opusfinder/db/env` (`getDatabaseUrl`); and the Phase-F6 health subpath `@opusfinder/db/health`
(`checkHealth(db, opts?)` → `HealthReport` — the PURE, serverless-safe pipeline-health core, composed from the
impure `gatherHealthSignals` + the pure `evaluateHealth`; plus `healthOptionsFromEnv` and the `isEnforceFiring`
predicate — callable verbatim from the `pnpm health` CLI and a future Phase-12 dev panel).

**Phase 9.5** added a second client behind `@opusfinder/db/auth-client`: `createAuthDb(connectionString)`,
a **transaction-capable neon-serverless** (WebSocket) Drizzle client. Better Auth's `signUpEmail` wraps
its `user`+`account` inserts in an interactive transaction the fetch-only neon-http `createDb` can't run
(#4747), so the auth adapter uses this handle — kept on its own subpath so the default neon-http client
is unaffected and the scrapers Worker never pulls neon-serverless/WebSocket into its bundle.

## Environment

The real connection string lives in `packages/db/.env` (gitignored). Copy the
repo-root `.env.example` there and set `DATABASE_URL` to your Neon **direct**
(non-pooled) connection string. `getDatabaseUrl()` (`src/env.ts`, built on
`@opusfinder/shared/env`'s `loadPackageEnv` + `requireEnv`) validates it is
a `postgres(ql)://` URL and, on failure, echoes only the scheme — never the
credentials. `loadPackageEnv(import.meta.url)` resolves `packages/db/.env`
relative to the module (not the cwd), so any package's scripts pick up
`DATABASE_URL` however they're invoked.

## Commands

Run from the repo root via the workspace filter so the cwd is `packages/db`:

| Command                                  | Does                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| `pnpm --filter @opusfinder/db migrate`   | Apply migrations from `./drizzle`                          |
| `pnpm --filter @opusfinder/db generate`  | `drizzle-kit generate` (offline; no DB needed)             |
| `pnpm --filter @opusfinder/db studio`    | Open Drizzle Studio                                        |
| `pnpm --filter @opusfinder/db ping`      | Round-trip `SELECT 1` against Neon                         |
| `pnpm --filter @opusfinder/db runs`      | Print the most recent `source_runs` rows (pipeline health) |
| `pnpm --filter @opusfinder/db test:health` | Health-checker smoke — pure `evaluateHealth` over canned signals (no creds; Phase F6) |
| `pnpm --filter @opusfinder/db typecheck` | `tsc --noEmit`                                             |

`migrate` and `ping` are also exposed at the root as `pnpm db:migrate` / `pnpm db:ping`.

> **Cwd matters.** `drizzle.config.ts` and the `./drizzle` migration path are
> **cwd-relative**, so db scripts must run with the cwd set to `packages/db` —
> always invoke them via `pnpm --filter @opusfinder/db <script>` (or `cd packages/db`
> first), never by pathing into the script directly. (Env loading is no longer
> cwd-relative — `getDatabaseUrl()` loads via `@opusfinder/shared/env`; see Environment above.)

## Caveats

- **Schema (Phase 2 + 4 + 7).** `src/schema.ts` defines `companies` (unique
  `(slug, source)`) and `jobs` (unique `(source, external_id)`, FK → `companies`,
  `company_id` index, text `lifecycle_state`). `jobs.embedding` is a nullable
  `vector(1024)` — width = the exported `EMBEDDING_DIMENSIONS` constant (the single source of truth, kept
  in sync with `@opusfinder/embeddings`' `EMBED_DIMENSIONS`); populated in Phase 4 and
  HNSW-indexed for cosine retrieval (`jobs_embedding_hnsw_idx`, `vector_cosine_ops`). pgvector is enabled
  via the SQL migration (`drizzle/0000_enable_pgvector.sql`), not declared in
  Drizzle; the tables land in `drizzle/0001_petite_namor.sql` and the HNSW index in
  `drizzle/0002_flashy_joshua_kane.sql`. **Phase 7** added the `source_runs` run-audit table
  (`pipeline` / `source` / `status` / `started_at` / `finished_at` / `counts` jsonb / `error_sample`;
  index `source_runs_pipeline_started_idx`) and four staleness columns on `companies` — `active`,
  `last_probed_at`, `last_live_at`, `consecutive_probe_failures` — plus the partial reprobe index
  `companies_active_last_probed_idx` (active rows, `last_probed_at ASC NULLS FIRST, id`). The
  `status`/`pipeline` fields are TS unions on plain `text` (not `pgEnum`), same idempotent-migration
  reason as `lifecycle_state`. The Phase-7 schema lands in `drizzle/0003_lame_black_tom.sql`, with
  every `CREATE TABLE` / `ADD COLUMN` / `CREATE INDEX` hand-guarded `IF NOT EXISTS`.
- **Schema (Phase 9 + 9.5).** Phase 9 added `user_cv_files` (append-only CV uploads + R2 keys) and
  `user_profiles` (one semantic profile per user — structured JSON + a `vector(1024)` HNSW-indexed
  embedding) in `drizzle/0004_curvy_shard.sql`. **Phase 9.5** added the Better Auth-owned identity
  tables `user` / `session` / `account` / `verification` (uuid ids via the `generateId: "uuid"` config)
  and the typed `user_preferences` table (filter + digest/delivery/unsubscribe settings; 1:1 FK →
  `user.id`) plus `repos/preferences.ts`, in `drizzle/0005_clammy_talisman.sql` (additive). The FKs from
  `user_cv_files.user_id` / `user_profiles.user_id` → `user.id` (ON DELETE CASCADE) were split into
  `drizzle/0006_large_diamondback.sql`: they couldn't land in 0005 because the throwaway Phase-9
  placeholder rows referenced no `user` row and would have failed FK validation until the §7b re-key wipe.
- **Schema (Phase 10).** Three additive digest tables in `drizzle/0007_fresh_wolfpack.sql` +
  `drizzle/0008_awesome_marvel_zombies.sql`: `digest_runs` (orchestrator/dispatch audit — mirrors
  `source_runs`, no company FK), `digests` (per-user header, UNIQUE `(user_id, digest_run_id)`, a
  `counts` metric bag), and `digest_items` (ranked items — `rank` / `score` / `reason` + a nullable
  Phase-12 `feedback` column). The composite `digest_items (user_id, job_id)` index backs the
  already-shown anti-join (`alreadyShownJobIds`) that feeds the next run's `excludeJobIds`. `status` /
  `trigger` / `feedback` are TS unions on plain `text` (same idempotent-migration rule as
  `lifecycle_state`). FKs cascade onto `user.id` / `digests.id` / `digest_runs.id`, but
  `digest_items.job_id` deliberately does **not** cascade — it's append-only dedup history, so a deleted
  job must not erase the record. **CASCADE HAZARD:** deleting a `digest_runs` row cascades
  run → digests → digest_items and erases that dedup history (no code deletes runs today; see the inline
  note in `schema.ts`).
- **Schema (Phase 11).** `drizzle/0009_aspiring_chameleon.sql` adds per-send delivery state ON
  `digests`: `email_id` (Resend id, NULL until accepted), `delivery_status`
  (`none|sent|delivered|bounced|failed` — a TS union, `DigestDeliveryStatus`), `sent_at`. Written only
  by the pipeline's send/poll/failure steps; the user-level aggregates (`last_digest_*`,
  `digest_bounce_status`, `digest_suppressed_at`) stay on `user_preferences`. The email repo surface
  (`repos/digests.ts`): `getDigestEmailPayload` (the render read — digests ⋈ user ⋈ digest_items ⋈
  jobs ⋈ companies in one round trip; items are filtered APP-SIDE to `lifecycle_state='active'` so a job
  closed between retrieval and send never renders — G1b: returns `null` only when the digest row vanished,
  vs empty `items` for a clean no-send) + `recordDigestSent` / `recordDigestDeliveryOutcome` /
  `recordDigestSendFailure`, smoke-checked by `pnpm --filter @opusfinder/db test:digest-payload`.
- **Schema (Phase F2).** `drizzle/0010_curly_drax.sql` adds `jobs.consecutive_absences`
  (`smallint NOT NULL DEFAULT 0`) — a pure-streak counter of consecutive trusted fetches in which an `active`
  job was absent; `lifecycle_state` flips to `'closed'` at the threshold (`ABSENCE_CLOSE_THRESHOLD`), and the
  streak resets + the job revives to `'active'` on reappearance. Mirrors `companies.consecutive_probe_failures`
  but is a pure streak (no 30-day window). F2 is the FIRST writer of `lifecycle_state='closed'` (retrieval
  already filtered on it). The lifecycle writers live in `repos/lifecycle.ts`: `sweepLifecycle` (Arm A —
  per-board feed-absence sweep, one race-safe SQL-side-increment UPDATE) + `closeJobsForCompanies` /
  `closeJobsByIds` (Arm B/C — bulk-close a dead board's still-active jobs / the explicit-410 digest items).
  `repos/discovery.ts`'s `deactivateStale` was widened to RETURN the deactivated ids (was a bare count) so
  Arm B can close their jobs. Soft-close only — never a row DELETE (F1 reads the closed row's signature;
  `digest_items.job_id` is `ON DELETE NO ACTION`). Smoke: `pnpm --filter @opusfinder/db test:lifecycle` (no
  creds). **Ships SHADOW / count-only by DEFAULT** — the `'closed'` flip is suppressed and tallied as
  `wouldClose` unless a SINGLE `LIFECYCLE_CLOSE_ENFORCE` switch (`parseEnforceFlag` in `@opusfinder/shared`) is on; it's
  threaded through all three arms with no multi-site code edit — the scrapers Worker reads `env.LIFECYCLE_CLOSE_ENFORCE`
  (wrangler `[vars]`) for Arms A/B, and the digest runtime reads `process.env.LIFECYCLE_CLOSE_ENFORCE` for Arm C.
  Note for `sweepLifecycle` (Arm A): "shadow" here means
  "no `'closed'` WRITE", NOT "no write at all" — it still persists the `consecutive_absences` streak
  (capped at the threshold) and revives reappearing rows by design, so the streak is warm when enforce
  flips on. This is a deliberate asymmetry vs the bulk Arm B/C closers (a pure count, zero writes in
  shadow) and vs the F6 health checks (pure reads); don't mistake the streak writes for a leak.
- **Schema (Phase F1).** `drizzle/0011_cool_silvermane.sql` (additive, hand-guarded `IF NOT EXISTS` — same
  neon-http discipline as 0002/0010) adds nullable, NON-unique `jobs.content_signature` (md5 over a normalized
  `title + chr(10) + description_text`: `lower` → `[[:space:]]+`-collapse → `btrim`) + the
  `jobs_content_signature_idx` btree — the read-time de-dup spine. The ONE normalization lives in `repos/sql.ts`
  `signatureSql` (with a smoke-only JS mirror `normalizeSignatureText` + a `textArrayLiteral` array-literal helper);
  it is written SQL-side in `upsertJobs` at all three call sites (INSERT VALUES, ON CONFLICT SET, the backfill) —
  unconditional, and DELIBERATELY NOT in `setWhere` (it is a pure function of title+description, which `setWhere`
  already tests). Two read paths collide on it: `collapseBySignature` (a retrieval display-collapse — a cross-post
  takes ONE digest slot) and `alreadyShownSignatures` → retrieval's additive `excludeSignatures` repost anti-join
  (`content_signature IS NULL OR <> ALL(...)`); NULL signatures are each their own group, never collapsed or
  excluded, so un-backfilled rows are inert, not wrong. `alreadyShownSignatures` carries NO `lifecycle_state`
  filter (a soft-closed predecessor's signature still suppresses its repost). Re-runnable backfill:
  `pnpm db:backfill-signatures` (`scripts/backfill-content-signature.ts`); no-creds smoke
  `pnpm --filter @opusfinder/db test:signature`. **LIVE** — migration 0011 is APPLIED and the rows are
  backfilled, so the display-collapse + repost anti-join read paths are active; the cosine near-dup layer
  (F1e/F1f) is DEFERRED.
- **Schema (Phase F3).** `drizzle/0012_dazzling_layla_miller.sql` (additive, hand-guarded `IF NOT EXISTS` — same
  neon-http discipline as 0002/0010/0011) adds five `user_preferences` columns — `max_salary`, `yoe_min`,
  `yoe_max`, `dealbreakers`, `location_mode` — and backfills `location_mode` from the now soft-deprecated (kept
  but unread) `remote_ok` (`true`→`'any'`, `false`→`'onsite_only'`). `location_mode` is a TS union
  (`LocationMode` = `'any' | 'remote_only' | 'onsite_only'`, same idempotent-migration rule as `lifecycle_state`);
  `repos/preferences.ts` `toRow` maps the new fields. Retrieval's `geoMatches` was REWRITTEN to branch on
  `LocationMode` (`remote_only` excludes on-site; `onsite_only` excludes remote — subsumes the old `remoteOk`
  boolean), and `RetrieveOpts.remoteOk` → `locationMode`. LOCATION is the only working hard filter in F3; salary +
  YoE are stored + soft-prompt-only (never hard filters). No-creds smokes:
  `pnpm --filter @opusfinder/db test:prefs` (preferences round-trip) + `pnpm --filter @opusfinder/db test:location`
  (`geoMatches` LocationMode branches). **APPLIED to prod.**
- **Schema (Phase F4) — job-side enrichment, REMOVED.** `drizzle/0013_cloudy_polaris.sql` originally added
  seven nullable `jobs` columns for job-side structured enrichment (`yoe_min`/`yoe_max`, `salary_min`/`salary_max`,
  `salary_currency`/`salary_period`, `enriched_at`). The feature was fully removed: `drizzle/0016` drops those
  columns and `repos/enrichment.ts` no longer exists. The salary/YoE *user* preferences on `user_preferences`
  (Phase F3) are unaffected — they remain soft prompt signals only.
- **Health checker (Phase F6) — NO migration.** `src/health.ts` (subpath `@opusfinder/db/health`) computes seven
  liveness checks (`ingestion_staleness`, `board_fail_ratio`, `discovery_window`, `embedding_backlog`,
  `digest_health` [error-runs only], `bounce_suppression`, `discovery_lane_errors` [F5f —
  per-lane `lane_<name>_error` on the latest all-source discovery run]) + a rerank-cache cost rollup from
  EXISTING columns across `source_runs` / `jobs` / `digest_runs` / `digests` / `user_preferences` — pure Neon
  reads, ZERO schema change. Split into `gatherHealthSignals` (the only impure fn — the reads issued
  concurrently, ages computed SQL-side so the evaluator needs no clock) + the PURE `evaluateHealth` (thresholds +
  `off|shadow|enforce` modes, shadow-first: validate on real traffic before flipping a check to enforce). Window
  sizes clamp to ≥1 so a `0` can't silently disarm the check it sizes. Read-only; shape-only (every metric is a
  count/age/ratio, no PII). The verdict layer is `pnpm health` (in `@opusfinder/inngest`); no-creds smoke
  `test:health`. (The CHECKER itself still adds NO migration — only the `health_alerts` TABLE below is 0014.)
- **Schema (Phase 12a).** `drizzle/0014_slow_red_hulk.sql` (additive) adds the append-only `health_alerts`
  incident log — `check_id` / `mode` / `metric` / `threshold` / `detail` / `created_at`, plus a `created_at`
  index. `check_id` / `mode` are plain `text` (NOT a TS union imported from `health.ts`) deliberately, to
  avoid a `schema.ts`→`health.ts`→client import cycle. **APPLIED to prod.** **Writer/reader (Phase H1b):**
  `repos/health-alerts.ts` — `recordHealthAlert(db, check, detail)` inserts one row per enforce-firing that
  actually paged, and `shouldNotify(db, checkId, cooldownH)` reads "any prior row within the cooldown window"
  for page-once-per-`HEALTH_ALERT_COOLDOWN_H` dedup (`DEFAULT_HEALTH_ALERT_COOLDOWN_H = 24`). The check shape
  is a LOCAL `HealthAlertInput` (a structural subset of `HealthCheck`), NOT a `health.ts` import — this repo
  is reachable from the scraper Worker's compile graph (via `@opusfinder/db/repos`), and `health.ts`
  references `process`, which would break the Worker's node-types-free typecheck. The 12b dev panel reads the
  same table for incident history; G3g's `pruneOplog` bounds it at 90d.
- **`jobs.raw` DEPRECATED — no longer written.** `drizzle/0015_known_black_queen.sql`
  (`ALTER COLUMN "raw" DROP NOT NULL`) made the untouched-source-payload column nullable. `raw` was
  write-only debug data that grew to ~90% of the database (442 MB of 489 MB), exhausting the Neon free-tier
  storage limit and failing every write on 2026-06-16. `upsertJobs` stopped writing it; the column is kept
  (nullable, for rollback/backfill safety) and the reclaim NULLed the existing rows. To re-derive richer
  text from a posting, re-ingest the board. (Mirrors the `jobs` doc comment in `schema.ts:108-128`;
  `INGEST_LIMIT` was restored to 150 once storage was freed.) **APPLIED to prod.**
- **Schema (Phase F4 enrichment cols DROPPED).** `drizzle/0016_friendly_rachel_grey.sql` (`DROP COLUMN IF
  EXISTS`) removes the seven job-side enrichment columns added by 0013 (`yoe_min`/`yoe_max`,
  `salary_min`/`salary_max`, `salary_currency`/`salary_period`, `enriched_at`) — see the Phase F4 bullet
  above for the full removal story. **APPLIED to prod.**
- **Index (Phase F8/F6) — `jobs_unembedded_idx`.** `drizzle/0017_uneven_doctor_spectrum.sql` (hand-guarded
  `CREATE INDEX IF NOT EXISTS`, same neon-http discipline as 0002) adds a partial btree
  `ON "jobs" ("id") WHERE "embedding" IS NULL`, so the recurring un-embedded scans index-scan instead of
  seq-scanning the whole table: the F6 `embedding_backlog` health count, `jobsNeedingEmbedding`, and the F8
  `embed-backlog-drain`'s `ORDER BY id LIMIT` paging. Self-prunes to ~0 entries as rows embed. **APPLIED to
  prod.**
- **neon-http migrations are NOT transactional.** The neon-http migrator applies
  a migration's statements without a wrapping transaction, so a multi-statement
  migration that fails partway leaves a partial apply with no rollback (and a
  re-run starts from the top). **Keep every migration idempotent/guarded**
  (`CREATE EXTENSION IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`, …). For an unavoidably non-idempotent
  multi-statement migration, run it through the websocket `neon-serverless`
  migrator instead. (See Phase 2 notes in the implementation plan.)
- **Embeddings repo (Phase 4).** `src/repos/embeddings.ts` adds `backfillJobEmbeddings()`
  (idempotent embed → write loop over NULL-embedding rows), `nearestJobs()` (cosine
  `<=>` over the HNSW index), `jobsNeedingEmbedding()`, `writeJobEmbeddings()`, and
  `jobEmbeddingText()` (title + description — the Phase-5 eval tunable). The embedder is
  **injected** (an `EmbedFn` parameter), so `db` keeps zero dependency on
  `@opusfinder/embeddings`; the dependency points the other way. Every `::vector(N)` cast
  is built once from `EMBEDDING_DIMENSIONS`.
- **Embedding invalidation on upsert (Phase 4).** `upsertJobs` resets `embedding` to
  `NULL` only when `title` OR `description_text` changed (a `CASE` in the conflict `set`);
  changes to other fields keep the existing vector, so re-embedding cost is paid only on
  real content change.
- **Canonical `locations` on upsert (Phase 6).** `upsertJobs` sorts each job's `locations`
  to a canonical order on write. `locations` is compared as an order-sensitive jsonb array in
  the change test, so a multi-location board that emits the same offices in a different order
  across runs would otherwise report a spurious change every ingest. (`runAdapter` already
  canonicalizes in memory; the sort here is the defense for any direct `upsertJobs` caller.)
- **0002 HNSW migration is hand-guarded.** drizzle-kit emits a bare `CREATE INDEX`;
  `0002_flashy_joshua_kane.sql` is hand-edited to `CREATE INDEX IF NOT EXISTS` because
  neon-http migrations aren't transactional (same discipline as the FK in 0001).
  `CREATE INDEX CONCURRENTLY` is deferred — the table is small and CONCURRENTLY can't run
  inside one neon-http call.
