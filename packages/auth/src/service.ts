import { eq } from "drizzle-orm";

import type { Db } from "@opusfinder/db";
import { getOrCreatePreferences } from "@opusfinder/db/repos";
import { user } from "@opusfinder/db/schema";
import { generateUnsubscribeToken, type UserId, type UserPreferences } from "@opusfinder/shared";

import type { Auth } from "./auth";

/**
 * The single user-creation business path the CLI (and any future HTTP handler) calls. Env-free: the
 * neon-http `db` + the constructed `auth` are injected (no process.env in src/). It does NOT take the
 * neon-serverless `authDb` separately — `auth` already wraps it (signUpEmail runs through the adapter),
 * and the verify flip + prefs write are single statements safe over neon-http `db`.
 *
 * NODE/SERVER-ONLY (it imports `auth`, hence better-auth) — never reachable from the scrapers Worker.
 */
export interface CreateUserInput {
  email: string;
  password: string;
  name?: string;
  /** Initial overrides on the preference column defaults (CLI flags / form fields). */
  prefs?: Partial<UserPreferences>;
  /** Seed-only: flip emailVerified=true after creation. */
  markVerified?: boolean;
}

/**
 * Create a real user (`user` + `account`) via Better Auth's `signUpEmail`, then (seed-only) flip
 * `emailVerified` and seed the 1:1 `user_preferences` row with a random unsubscribe token. Returns the
 * branded `user.id`.
 *
 * `signUpEmail` wraps the `user`+`account` inserts in a transaction (why `auth` must be backed by the
 * neon-serverless `authDb`); the verify UPDATE + prefs upsert are separate single statements on `db`.
 * Not atomic across those steps — acceptable for seed data, and `getOrCreateUserByEmail` makes the
 * prefs step idempotent on a retry.
 */
export async function createUserWithPreferences(
  db: Db,
  auth: Auth,
  input: CreateUserInput,
): Promise<{ userId: UserId }> {
  // 1. user + account, in a transaction.
  const signUpResult = await auth.api.signUpEmail({
    body: {
      email: input.email,
      password: input.password,
      name: input.name ?? input.email,
    },
  });
  const userId = signUpResult.user.id as UserId;

  // 2. signUpEmail hardcodes emailVerified:false; the admin plugin would need a session a CLI lacks,
  //    so a direct single-row UPDATE is the correct seed-only path (safe over neon-http).
  if (input.markVerified) {
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, userId));
  }

  // 3. The unsubscribe token is set once here (random, never email-derived).
  await getOrCreatePreferences(db, {
    userId,
    unsubscribeToken: generateUnsubscribeToken(),
    prefs: input.prefs,
  });

  return { userId };
}

/**
 * Resolve a real `user.id` from an email alone (the CV-ingest path, which has no password): look up an
 * existing user, else create a verified one with a throwaway random password — the person claims the
 * account via password reset later. Idempotent on email (normalized trim+lowercase), and tolerant of a
 * lost create race.
 */
export async function getOrCreateUserByEmail(
  db: Db,
  auth: Auth,
  email: string,
  opts?: { prefs?: Partial<UserPreferences> },
): Promise<{ userId: UserId }> {
  const normalized = email.trim().toLowerCase();
  const found = await findUserIdByNormalizedEmail(db, normalized);
  if (found) {
    // Backfill the prefs row for a user that predates it / a partial earlier create (idempotent).
    await getOrCreatePreferences(db, {
      userId: found,
      unsubscribeToken: generateUnsubscribeToken(),
    });
    return { userId: found };
  }
  try {
    return await createUserWithPreferences(db, auth, {
      email: normalized,
      // A throwaway, cryptographically-random password (≥ better-auth's 8-char min). Ingest-created
      // users can't log in until they reset it; identity here is the email, not a credential.
      password: generateUnsubscribeToken(),
      markVerified: true,
      prefs: opts?.prefs,
    });
  } catch (err) {
    // Lost a race (the email now exists) — re-resolve rather than fail the ingest.
    const reResolved = await findUserIdByNormalizedEmail(db, normalized);
    if (reResolved) return { userId: reResolved };
    throw err;
  }
}

/**
 * Resolve a user id from an email (normalized trim+lowercase, matching creation), or null. The public
 * lookup used by the `user:set-prefs` / `user:list` CLIs and `getOrCreateUserByEmail`.
 */
export async function findUserIdByEmail(db: Db, email: string): Promise<UserId | null> {
  return findUserIdByNormalizedEmail(db, email.trim().toLowerCase());
}

/** The user id for a (pre-normalized) email, or null. */
async function findUserIdByNormalizedEmail(db: Db, normalizedEmail: string): Promise<UserId | null> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, normalizedEmail))
    .limit(1);
  return rows[0]?.id ?? null;
}
