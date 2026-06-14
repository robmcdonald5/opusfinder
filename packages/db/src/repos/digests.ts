/**
 * Persistence for the Phase-10 digest pipeline: the eligible-recipient query, the already-shown
 * anti-join, and the run/header/item writes. Same functional style as ./jobs and ./discovery — the
 * Drizzle client is injected, every mutation is a single neon-http round-trip, and time math is
 * SQL-side (`now()`). The run helpers mirror ./discovery's `startRun`/`finishRun` against `digest_runs`.
 */
import { and, desc, eq, gt, isNotNull, isNull, sql, type SQL } from "drizzle-orm";

import type { DigestTrigger, UserId } from "@opusfinder/shared";

import type { Db } from "../client";
import {
  companies,
  digestItems,
  digestRuns,
  digests,
  jobs,
  user,
  userPreferences,
  userProfiles,
  type DigestBounceStatus,
  type DigestDeliveryStatus,
  type RunCounts,
  type RunStatus,
} from "../schema";
import { finishRunRow } from "./runs";
import { intArrayLiteral, NUL } from "./sql";

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
 * here (Phase 10/11 trigger manually; the Phase-12 cadence cron adds a `digest_cadence` predicate). The
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
 * like `failStaleRuns` — covering a serve process killed outside a step — is deferred to Phase 12 with
 * the cadence cron: an unattended-runtime problem, not a watched-manual-run one.)
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

// --- Phase F2 Arm C: the pre-send liveness probe's apply-URL read + the drop-dead-items write -----

/** One persisted digest item's job id + apply URL — the liveness probe's input (re-read by digest id,
 *  not threaded through Inngest step state, mirroring the embedding-re-read discipline). */
export interface DigestApplyTarget {
  jobId: number;
  applyUrl: string;
}

/**
 * The (jobId, applyUrl) of every item in one digest — Arm C HEAD/GET-probes these before send. INNER JOIN
 * is safe (persist throws on zero kept items, so an existing digest has ≥1 item). Ordered by rank for a
 * stable probe order.
 */
export function getDigestApplyTargets(db: Db, digestId: number): Promise<DigestApplyTarget[]> {
  return db
    .select({ jobId: digestItems.jobId, applyUrl: jobs.applyUrl })
    .from(digestItems)
    .innerJoin(jobs, eq(jobs.id, digestItems.jobId))
    .where(eq(digestItems.digestId, digestId))
    .orderBy(digestItems.rank);
}

/**
 * Drop the dead-link items (Arm C: a 404/410 apply URL) from a digest and fold the probe tallies into its
 * `counts`, in ONE statement: a data-modifying CTE deletes the dropped `digest_items` (always runs, even
 * when none are dropped — Postgres executes an unreferenced data-modifying CTE to completion), then the
 * UPDATE sets `item_count` to the survivor count (passed in, since the CTE's delete is not visible to a
 * same-statement `count(*)`) and merges the probe counts via jsonb `||`. This keeps the persisted
 * `digest_items` equal to what the user is actually SENT (the email render reads only the survivors).
 *
 * CAVEAT — Arm C / shown-history coupling: `alreadyShownJobIds` derives the next run's dedup anti-join from
 * `digest_items`, so a DROPPED job is also removed from shown-history. For a 410 that is fine (the job is
 * also soft-closed, so retrieval excludes it anyway). For a 404 — dropped but NOT closed (it may be a CDN
 * blip) — the job stays retrieval-eligible AND loses its shown record, so it can re-surface and re-pay
 * synthesis on a later digest until Arm A's streak or recency clears it. Bounded (≤TOP_K, ~daily cadence)
 * and accepted for v1; if `probed404Dropped` trends high on the same jobs at the F2f live gate, switch to a
 * tombstone (keep the row with a `dropped` flag, exclude only at render) so the anti-join stays intact.
 * Empty `droppedJobIds` still records the counts; ranks are left with gaps (the email orders by rank — inert).
 */
export async function dropDigestItemsAndRecount(
  db: Db,
  digestId: number,
  droppedJobIds: number[],
  survivorCount: number,
  probeCounts: Record<string, number>,
): Promise<void> {
  const idList = intArrayLiteral(droppedJobIds);
  await db.execute(sql`
    WITH dropped AS (
      DELETE FROM ${digestItems}
      WHERE digest_id = ${digestId} AND job_id = ANY(${idList}::int[])
      RETURNING 1
    )
    UPDATE ${digests}
    SET item_count = ${survivorCount}, counts = counts || ${JSON.stringify(probeCounts)}::jsonb
    WHERE id = ${digestId}
  `);
}

// --- Phase 11 email delivery: the render read + the per-send / user-level state writes -----------

/**
 * Everything the email render needs for one digest — ONE round trip:
 * `digests ⋈ user ⋈ digest_items ⋈ jobs ⋈ companies`, ORDER BY rank. INNER JOINs are safe: the
 * persist step throws on zero kept items, so an existing digest always has ≥1 item row here.
 * `companySlug` is `companies.slug` — there is NO name column (metadata jsonb is unpopulated).
 */
export interface DigestEmailPayload {
  digestId: number;
  userId: UserId;
  recipient: { email: string; name: string };
  /** The ONLY date the template may render — the rendered payload must be deterministic per digest
   *  (Resend Idempotency-Key replays reject a changed payload with 409), so no `new Date()`. */
  createdAt: Date;
  items: {
    rank: number;
    reason: string;
    title: string;
    companySlug: string;
    applyUrl: string;
    locations: string[];
    remote: boolean;
  }[];
}

/**
 * The email payload for one digest, recipient resolved from `user` (the row is the truth — never
 * event data). `null` for an unknown digest id; the send step treats that as an invariant break and
 * throws (same posture as the rerank-permutation check).
 */
export async function getDigestEmailPayload(
  db: Db,
  digestId: number,
): Promise<DigestEmailPayload | null> {
  const rows = await db
    .select({
      userId: digests.userId,
      createdAt: digests.createdAt,
      email: user.email,
      name: user.name,
      rank: digestItems.rank,
      reason: digestItems.reason,
      title: jobs.title,
      companySlug: companies.slug,
      applyUrl: jobs.applyUrl,
      locations: jobs.locations,
      remote: jobs.remote,
    })
    .from(digests)
    .innerJoin(user, eq(user.id, digests.userId))
    .innerJoin(digestItems, eq(digestItems.digestId, digests.id))
    .innerJoin(jobs, eq(jobs.id, digestItems.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(digests.id, digestId))
    .orderBy(digestItems.rank);
  const first = rows[0];
  if (!first) return null;
  return {
    digestId,
    userId: first.userId,
    recipient: { email: first.email, name: first.name },
    createdAt: first.createdAt,
    items: rows.map((r) => ({
      rank: r.rank,
      reason: r.reason,
      title: r.title,
      companySlug: r.companySlug,
      applyUrl: r.applyUrl,
      locations: r.locations,
      remote: r.remote,
    })),
  };
}

/**
 * Send accepted by Resend: `digests.email_id` + `delivery_status='sent'` + `sent_at=now()`, THEN the
 * user-level `last_digest_sent_at`/`last_digest_email_id`. Two writes, digests first — neon-http is
 * non-transactional, but both are idempotent, so a crash between them is healed by the Inngest step
 * retry re-running both (with the SAME emailId, via the Resend idempotency replay).
 */
export async function recordDigestSent(db: Db, digestId: number, emailId: string): Promise<void> {
  const rows = await db
    .update(digests)
    .set({ emailId, deliveryStatus: "sent", sentAt: sql`now()` })
    .where(eq(digests.id, digestId))
    .returning({ userId: digests.userId });
  const row = rows[0];
  if (!row) throw new Error(`recordDigestSent matched no digest (id ${digestId})`);
  await db
    .update(userPreferences)
    .set({ lastDigestSentAt: sql`now()`, lastDigestEmailId: emailId, updatedAt: sql`now()` })
    .where(eq(userPreferences.userId, row.userId));
}

/**
 * The delivery poll's mapped outcome (the event→status policy lives in @opusfinder/inngest).
 * `suppress` present = stop sending to this user (`digest_suppressed_at`); `suppress.bounce` is
 * OPTIONAL so a spam complaint can suppress WITHOUT touching `digest_bounce_status` (a complaint is
 * not a bounce — forcing a value here could reset a previously recorded hard bounce).
 */
export interface DigestDeliveryOutcome {
  status: DigestDeliveryStatus;
  suppress?: { bounce?: DigestBounceStatus };
}

/**
 * Record what the bounded delivery poll observed: upgrade `digests.delivery_status`, and on a
 * suppressing outcome write the user-level suppression. `COALESCE` keeps a re-run (the record step is
 * retry-idempotent) from moving an already-set suppression timestamp.
 */
export async function recordDigestDeliveryOutcome(
  db: Db,
  digestId: number,
  outcome: DigestDeliveryOutcome,
): Promise<void> {
  const rows = await db
    .update(digests)
    .set({ deliveryStatus: outcome.status })
    .where(eq(digests.id, digestId))
    .returning({ userId: digests.userId });
  const row = rows[0];
  if (!row) throw new Error(`recordDigestDeliveryOutcome matched no digest (id ${digestId})`);
  if (!outcome.suppress) return;
  await db
    .update(userPreferences)
    .set({
      digestSuppressedAt: sql`COALESCE(${userPreferences.digestSuppressedAt}, now())`,
      ...(outcome.suppress.bounce ? { digestBounceStatus: outcome.suppress.bounce } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(userPreferences.userId, row.userId));
}

/**
 * Terminal send failure (the send step exhausted its retries): `delivery_status='failed'`;
 * `email_id`/`sent_at` stay NULL. Deliberately does NOT throw on a missing digest row — this runs in
 * the failure path (a missing row may be the very cause), and a second error would mask the original.
 */
export async function recordDigestSendFailure(db: Db, digestId: number): Promise<void> {
  await db.update(digests).set({ deliveryStatus: "failed" }).where(eq(digests.id, digestId));
}
