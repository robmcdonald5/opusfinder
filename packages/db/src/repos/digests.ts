/**
 * Persistence for the Phase-10 digest pipeline: the eligible-recipient query, the already-shown
 * anti-join, and the run/header/item writes. Same functional style as ./jobs and ./discovery — the
 * Drizzle client is injected, every mutation is a single neon-http round-trip, and time math is
 * SQL-side (`now()`). The run helpers mirror ./discovery's `startRun`/`finishRun` against `digest_runs`.
 */
import { and, desc, eq, gt, isNotNull, isNull, type SQL } from "drizzle-orm";

import type { DigestTrigger, UserId } from "@opusfinder/shared";

import type { Db } from "../client";
import {
  digestItems,
  digestRuns,
  digests,
  user,
  userPreferences,
  userProfiles,
  type RunCounts,
  type RunStatus,
} from "../schema";
import { finishRunRow } from "./runs";
import { NUL } from "./sql";

/** A user eligible to receive a digest (just the id — the per-user function reads the rest). */
export interface DigestRecipient {
  userId: UserId;
}

/**
 * The next batch of users eligible for a digest, id-keyset paginated (matching `listCompanies`):
 * `WHERE id > afterId ORDER BY id LIMIT limit`. Eligibility = delivery on (`digest_enabled`), a
 * verified email (`user.email_verified` — the send gate), not suppressed (`digest_suppressed_at IS
 * NULL`), AND a usable profile vector (INNER JOIN `user_profiles` + `embedding IS NOT NULL`, so a user
 * with no CV / no embedding is skipped — they can't be matched). Cadence is deliberately NOT filtered
 * here (Phase 10 triggers manually; the Phase-11 cadence cron adds a `digest_cadence` predicate). The
 * keyset orders by `user.id` (uuid) — an arbitrary but total, stable order, all that chunked iteration
 * needs.
 */
export function listDigestRecipients(
  db: Db,
  opts: { afterId?: UserId; limit: number },
): Promise<DigestRecipient[]> {
  const conditions: SQL[] = [
    eq(userPreferences.digestEnabled, true),
    eq(user.emailVerified, true),
    isNull(userPreferences.digestSuppressedAt),
    isNotNull(userProfiles.embedding),
  ];
  if (opts.afterId !== undefined) conditions.push(gt(user.id, opts.afterId));
  return db
    .select({ userId: user.id })
    .from(user)
    .innerJoin(userPreferences, eq(userPreferences.userId, user.id))
    .innerJoin(userProfiles, eq(userProfiles.userId, user.id))
    .where(and(...conditions))
    .orderBy(user.id)
    .limit(opts.limit);
}

/**
 * The distinct job ids already shown to a user across all prior digests — the `digest_items`
 * (user_id, job_id) anti-join, fed to `retrieveCandidatesForProfile`'s `excludeJobIds` so a job is
 * not re-surfaced. `selectDistinct` (not app-side dedup) leans on the composite
 * `digest_items_user_id_job_id_idx`. Empty for a first-time recipient.
 */
export async function alreadyShownJobIds(db: Db, userId: UserId): Promise<number[]> {
  const rows = await db
    .selectDistinct({ jobId: digestItems.jobId })
    .from(digestItems)
    .where(eq(digestItems.userId, userId));
  return rows.map((r) => r.jobId);
}

/**
 * Open a digest run: insert a `running` row (status + started_at from column defaults) and return its
 * id. Mirrors ./discovery `startRun`. Call BEFORE fan-out so a crash leaves a visible `running` row;
 * `finishDigestRun` patches it to a terminal state — the orchestrator calls it on success AND from its
 * catch (status 'error' + `error_sample`) when a step exhausts its retries. (A stale-`running` sweep
 * like `failStaleRuns` — covering a serve process killed outside a step — is deferred to Phase 11 with
 * the cadence cron.)
 */
export async function startDigestRun(db: Db, trigger: DigestTrigger): Promise<number> {
  const rows = await db.insert(digestRuns).values({ trigger }).returning({ id: digestRuns.id });
  const row = rows[0];
  if (!row) throw new Error(`startDigestRun inserted no row (trigger "${trigger}")`);
  return row.id;
}

/**
 * Close a digest run: stamp `finished_at`, write the terminal status + metric bag, and (on error) a
 * truncated, SECRET-free sample. Mirrors ./discovery `finishRun`. The `status = 'running'` predicate
 * terminalizes a run exactly ONCE (a double finish is a no-op). Meant to run in a `finally`.
 */
export async function finishDigestRun(
  db: Db,
  runId: number,
  result: { status: Exclude<RunStatus, "running">; counts: RunCounts; errorSample?: string },
): Promise<void> {
  await finishRunRow(db, digestRuns, runId, result);
}

/** A per-user digest header to write (one per user per run). */
export interface NewDigest {
  userId: UserId;
  digestRunId: number;
  itemCount: number;
  counts: RunCounts;
}

/**
 * Insert a per-user digest header and return its id. A plain INSERT: the `(user_id, digest_run_id)`
 * UNIQUE constraint is the guard against a double-write. NOTE: the Phase-10f persist step makes itself
 * retry-idempotent by deleting any prior digest for this (user, run) first — the digest→items FK
 * cascade clears its items — then inserting fresh; that delete helper lands with the persist step.
 */
export async function insertDigest(db: Db, input: NewDigest): Promise<{ id: number }> {
  const rows = await db
    .insert(digests)
    .values({
      userId: input.userId,
      digestRunId: input.digestRunId,
      itemCount: input.itemCount,
      counts: input.counts,
    })
    .returning({ id: digests.id });
  const row = rows[0];
  if (!row) throw new Error(`insertDigest returned no row for user ${input.userId}`);
  return row;
}

/** A ranked digest item to write. `rank`/`score` come from the rerank; `reason` from synthesis. */
export interface NewDigestItem {
  jobId: number;
  rank: number;
  score: number;
  reason: string;
}

/**
 * Batch-insert a digest's ranked items in one statement. `userId` is denormalized onto each row (the
 * already-shown anti-join keys on it). `reason` is NUL-stripped (Postgres text can't store U+0000),
 * same discipline as the other text writes. An empty list is a no-op.
 * Top-K is small (~12), well under the bind-param ceiling, so no chunking.
 */
export async function insertDigestItems(
  db: Db,
  digestId: number,
  userId: UserId,
  items: NewDigestItem[],
): Promise<void> {
  if (items.length === 0) return;
  await db.insert(digestItems).values(
    items.map((it) => ({
      digestId,
      userId,
      jobId: it.jobId,
      rank: it.rank,
      score: it.score,
      reason: it.reason.replaceAll(NUL, ""),
    })),
  );
}

/**
 * Delete a user's digest for one run — the retry-idempotency primitive for the Phase-10f persist step.
 * The digest→items FK cascade removes its `digest_items` too, so a retried per-user run deletes-then-
 * inserts fresh instead of colliding with the `(user_id, digest_run_id)` unique constraint (a header-
 * only upsert would leave stale items behind). No-op if no digest exists yet.
 */
export async function deleteUserDigestForRun(
  db: Db,
  userId: UserId,
  digestRunId: number,
): Promise<void> {
  await db.delete(digests).where(and(eq(digests.userId, userId), eq(digests.digestRunId, digestRunId)));
}

/** A user's most-recent digest header + its ranked items — read by the trigger CLI (and the Phase-12
 *  history view). Newest by created_at then id. `null` if the user has no digest yet. */
export interface DigestView {
  id: number;
  digestRunId: number;
  itemCount: number;
  counts: RunCounts;
  createdAt: Date;
  items: { jobId: number; rank: number; score: number; reason: string }[];
}

export async function getLatestDigestForUser(db: Db, userId: UserId): Promise<DigestView | null> {
  const rows = await db
    .select()
    .from(digests)
    .where(eq(digests.userId, userId))
    .orderBy(desc(digests.createdAt), desc(digests.id))
    .limit(1);
  const d = rows[0];
  if (!d) return null;
  const items = await db
    .select({
      jobId: digestItems.jobId,
      rank: digestItems.rank,
      score: digestItems.score,
      reason: digestItems.reason,
    })
    .from(digestItems)
    .where(eq(digestItems.digestId, d.id))
    .orderBy(digestItems.rank);
  return {
    id: d.id,
    digestRunId: d.digestRunId,
    itemCount: d.itemCount,
    counts: d.counts,
    createdAt: d.createdAt,
    items,
  };
}
