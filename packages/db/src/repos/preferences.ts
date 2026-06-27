/**
 * Persistence for `user_preferences` — the 1:1 settings row per user. Same functional
 * style as the other repos: the Drizzle client is injected, no module-level singleton. The user-
 * settable subset is typed by `UserPreferences` (@opusfinder/shared); delivery STATE columns
 * (`digestSuppressedAt`/`digestBounceStatus`/`lastDigest*`) are written by the send path, not
 * here. `unsubscribeToken` is generated ONCE by the caller (generateUnsubscribeToken) at creation and
 * never rotated by these functions.
 */
import { eq, sql } from "drizzle-orm";

import type { UserId, UserPreferences } from "@opusfinder/shared";

import type { Db } from "../client";
import { userPreferences } from "../schema";

/** A full `user_preferences` row (settable prefs + delivery state). */
export type UserPreferencesRow = typeof userPreferences.$inferSelect;

/** Read a user's preferences row, or null if none exists yet. */
export async function getPreferences(db: Db, userId: UserId): Promise<UserPreferencesRow | null> {
  const rows = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export interface CreatePreferencesInput {
  userId: UserId;
  /** Cryptographically-random token (generateUnsubscribeToken) — set once, here, at creation. */
  unsubscribeToken: string;
  /** Optional initial overrides on the column defaults (CLI flags / form fields). */
  prefs?: Partial<UserPreferences>;
}

/**
 * Create the 1:1 preferences row with column defaults + any provided overrides + the unsubscribe
 * token. IDEMPOTENT on `user_id`: if a row already exists it is left untouched (token NOT rotated) and
 * returned — so this is safe to call on every `getOrCreateUserByEmail`.
 */
export async function getOrCreatePreferences(
  db: Db,
  input: CreatePreferencesInput,
): Promise<UserPreferencesRow> {
  const inserted = await db
    .insert(userPreferences)
    .values({
      userId: input.userId,
      unsubscribeToken: input.unsubscribeToken,
      ...toRow(input.prefs),
    })
    .onConflictDoNothing({ target: userPreferences.userId })
    .returning();
  if (inserted[0]) return inserted[0];
  // Conflict → onConflictDoNothing returned no row; the existing row is the source of truth.
  const existing = await getPreferences(db, input.userId);
  if (!existing) throw new Error(`getOrCreatePreferences: no row after upsert for ${input.userId}`);
  return existing;
}

/**
 * Patch the user-SETTABLE preference fields on an existing row (the `user:set-prefs` CLI / settings
 * form). Never touches delivery state or the unsubscribe token. Throws if the user has no preferences
 * row (created at user creation, so a missing row is a real error, not a silent insert).
 */
export async function updatePreferences(
  db: Db,
  userId: UserId,
  patch: Partial<UserPreferences>,
): Promise<UserPreferencesRow> {
  const set = toRow(patch);
  if (Object.keys(set).length === 0) {
    const current = await getPreferences(db, userId);
    if (!current) throw new Error(`updatePreferences: no preferences row for ${userId}`);
    return current;
  }
  const rows = await db
    .update(userPreferences)
    .set({ ...set, updatedAt: sql`now()` })
    .where(eq(userPreferences.userId, userId))
    .returning();
  if (!rows[0]) throw new Error(`updatePreferences: no preferences row for ${userId}`);
  return rows[0];
}

/**
 * Grant or revoke the digest SEND PERMIT — the operator-written `digest_approved_at` gate. Lives HERE
 * (not in updatePreferences/toRow) because it is operator/pipeline STATE, not a user-settable preference —
 * the exact posture of `digest_suppressed_at`, which is likewise never in toRow. `approve=true` stamps
 * `now()` but COALESCEs onto any existing value so a re-approve is idempotent and PRESERVES the original
 * grant instant (the audit timestamp); `approve=false` clears it back to NULL (un-approved = fail-closed,
 * no send). Single idempotent write; throws if the user has no preferences row (created at user creation,
 * so a missing row is a real error, not a silent insert).
 */
export async function setDigestApproval(
  db: Db,
  userId: UserId,
  approved: boolean,
): Promise<UserPreferencesRow> {
  const rows = await db
    .update(userPreferences)
    .set({
      digestApprovedAt: approved ? sql`COALESCE(${userPreferences.digestApprovedAt}, now())` : null,
      updatedAt: sql`now()`,
    })
    .where(eq(userPreferences.userId, userId))
    .returning();
  if (!rows[0]) throw new Error(`setDigestApproval: no preferences row for ${userId}`);
  return rows[0];
}

/**
 * Map the shared `UserPreferences` (settable subset, camelCase) onto the table's insert/update
 * columns, DROPPING `undefined` keys so column defaults (on create) / existing values (on update) are
 * preserved. `minSalary: null` is kept (an explicit "no floor"); only `undefined` means "leave alone".
 */
function toRow(prefs?: Partial<UserPreferences>): Partial<typeof userPreferences.$inferInsert> {
  const row: Partial<typeof userPreferences.$inferInsert> = {};
  if (!prefs) return row;
  if (prefs.locationMode !== undefined) row.locationMode = prefs.locationMode;
  if (prefs.locations !== undefined) row.locations = prefs.locations;
  if (prefs.minSalary !== undefined) row.minSalary = prefs.minSalary;
  if (prefs.maxSalary !== undefined) row.maxSalary = prefs.maxSalary;
  if (prefs.yoeMin !== undefined) row.yoeMin = prefs.yoeMin;
  if (prefs.yoeMax !== undefined) row.yoeMax = prefs.yoeMax;
  if (prefs.recencyDays !== undefined) row.recencyDays = prefs.recencyDays;
  if (prefs.exclusions !== undefined) row.exclusions = prefs.exclusions;
  if (prefs.dealbreakers !== undefined) row.dealbreakers = prefs.dealbreakers;
  if (prefs.digestCadence !== undefined) row.digestCadence = prefs.digestCadence;
  if (prefs.digestEnabled !== undefined) row.digestEnabled = prefs.digestEnabled;
  return row;
}
