import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@opusfinder/db";
import type { AuthDb } from "@opusfinder/db/auth-client";
import { account, session, user, userPreferences, verification } from "@opusfinder/db/schema";
import type { UserId } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";

import {
  createAuth,
  createUserWithPreferences,
  findUserIdByEmail,
  getOrCreateUserByEmail,
  type Auth,
} from "./index";

// What this file proves: the auth service's user-creation business path over REAL better-auth
// signUpEmail + real PGlite Postgres — the create path (user + credential account, DB-generated uuid,
// lowercased email, no session under autoSignIn:false), the seed-only emailVerified flip (scoped,
// bystander-proof), the prefs seeding (defaults / overrides / 64-hex token), the documented NON-ATOMIC
// error contract (duplicate email = better-auth 1.6.14's phantom-uuid generic-duplicate response → FK
// reject; poisoned-Db step failures leave the half-created user), getOrCreateUserByEmail's idempotency
// + lost-race recovery, and findUserIdByEmail's normalized exact-eq lookup. NOT this file's job: the
// neon-serverless driver protocol (auth.integration.test.ts owns that live gate) and prefs flag
// parsing (prefs-flags.test.ts).
//
// NEVER import ./env here — it runs loadPackageEnv at module scope against the real packages/auth/.env
// and would demand a real BETTER_AUTH_SECRET. The auth instance gets literals instead.

/** Explicit deterministic uuid for direct-seeded rows (bystanders, lookup-only users). */
function uid(n: number): UserId {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as UserId;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Rejection capture: resolves to the error (or null if the promise resolved). */
function captureRejection(p: Promise<unknown>): Promise<Error | null> {
  return p.then(
    () => null,
    (e: unknown) => e as Error,
  );
}

describe("auth service — createUserWithPreferences / getOrCreateUserByEmail / findUserIdByEmail (integration: real better-auth over PGlite)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;
  let auth: Auth;

  beforeAll(async () => {
    // Defensive: better-auth telemetry is already skipped under NODE_ENV=test, but the MSW setup makes
    // any unmocked egress a hard error, so belt-and-braces it off. Unstubbed in afterAll.
    vi.stubEnv("BETTER_AUTH_TELEMETRY", "0");
    ({ db, close } = await createTestDb());
    // ONE real better-auth instance over the SAME PGlite drizzle handle (the documented R1 cast — the
    // drizzle adapter resolves tables from db._.fullSchema, identical to createAuthDb's). Literal fake
    // secret (≥32 chars) + baseURL; auth keeps THIS real db reference even when a test hands the
    // service a poisoned Proxy.
    auth = createAuth(db as unknown as AuthDb, {
      secret: "vitest-only-fake-secret-0123456789abcdef0123456789abcdef",
      baseURL: "http://localhost:3000",
    });
  });
  beforeEach(async () => {
    // The reserved "user" table is interpolated as a drizzle table object so quoting is never hand-rolled.
    await db.execute(
      sql`TRUNCATE TABLE ${userPreferences}, ${account}, ${session}, ${verification}, ${user} RESTART IDENTITY CASCADE`,
    );
  });
  afterAll(async () => {
    // Optional-chained: if beforeAll's createTestDb() rejected, a bare close() would bury the real
    // failure under a secondary TypeError. Drains the WASM handle → clean Windows teardown.
    await close?.();
    vi.unstubAllEnvs();
  });

  /** Direct-seeded user (NO better-auth, no scrypt cost) for bystanders and lookup-only rows. */
  async function seedUser(
    n: number,
    overrides: { email: string; emailVerified?: boolean; name?: string },
  ): Promise<UserId> {
    const id = uid(n);
    await db.insert(user).values({
      id,
      name: overrides.name ?? `Seed ${n}`,
      email: overrides.email,
      emailVerified: overrides.emailVerified ?? false,
    });
    return id;
  }

  /** Direct-seeded prefs row. unsubscribe_token is UNIQUE — callers pass distinct tokens. */
  async function seedPrefs(
    userId: UserId,
    overrides: Partial<typeof userPreferences.$inferInsert> & { unsubscribeToken: string },
  ): Promise<void> {
    await db.insert(userPreferences).values({ userId, ...overrides });
  }

  async function userById(id: UserId) {
    const rows = await db.select().from(user).where(eq(user.id, id));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function prefsRow(userId: UserId) {
    const rows = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  function accountRows(userId: UserId) {
    return db.select().from(account).where(eq(account.userId, userId));
  }

  function allUserRows() {
    return db.select({ id: user.id, email: user.email }).from(user);
  }

  function allPrefsRows() {
    return db.select({ id: userPreferences.id }).from(userPreferences);
  }

  function allSessionRows() {
    return db.select({ id: session.id }).from(session);
  }

  /**
   * The non-atomicity seam: a Proxy over the REAL Db that throws the sentinel when the service touches
   * the poisoned method, while delegating everything else (bound to the real target so drizzle's
   * `this` never sees the proxy). `auth` holds its own real Db reference, so signUpEmail still commits.
   */
  function poisonDb(realDb: Db, poisonedMethod: "insert" | "update", sentinel: Error): Db {
    return new Proxy(realDb, {
      get(target, prop) {
        if (prop === poisonedMethod) throw sentinel;
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  describe("createUserWithPreferences — create path (real better-auth signUpEmail over PGlite)", () => {
    it("creates user + credential account rows and returns the persisted row uuid as userId", async () => {
      const { userId } = await createUserWithPreferences(db, auth, {
        email: "create1@svc.test",
        password: "pw-longenough-1",
      });
      // generateId:'uuid' + provider 'pg' → better-auth OMITS the id and gen_random_uuid() fires — so
      // the returned id must be a uuid that resolves the PERSISTED row (not some synthetic id).
      expect(userId).toMatch(UUID_RE);
      const row = await userById(userId);
      expect(row.email).toBe("create1@svc.test");
      const accts = await accountRows(userId);
      expect(accts).toHaveLength(1);
      expect(accts[0]!.providerId).toBe("credential");
      // better-auth sets accountId = the created user's id for credential accounts.
      expect(accts[0]!.accountId).toBe(userId);
      expect(await allUserRows()).toHaveLength(1);
    });

    it("lowercases the stored email — MiXeD@Case.test lands mixed@case.test", async () => {
      const { userId } = await createUserWithPreferences(db, auth, {
        email: "MiXeD@Case.test",
        password: "pw-longenough-1",
      });
      // better-auth normalizes email.toLowerCase() before the insert (sign-up route); the service adds
      // NO trim normalization on this direct path (only getOrCreateUserByEmail trims).
      expect((await userById(userId)).email).toBe("mixed@case.test");
    });

    it("defaults name to the email when omitted; stores the given name when passed", async () => {
      const a = await createUserWithPreferences(db, auth, {
        email: "noname@svc.test",
        password: "pw-longenough-1",
      });
      // input.name ?? input.email — the CLI's no-name path.
      expect((await userById(a.userId)).name).toBe("noname@svc.test");

      const b = await createUserWithPreferences(db, auth, {
        email: "named@svc.test",
        password: "pw-longenough-1",
        name: "Jo Named",
      });
      expect((await userById(b.userId)).name).toBe("Jo Named");
    });

    it("stores a scrypt hash on account.password — non-empty and not the plaintext (asserted by shape only)", async () => {
      const plaintext = "hunter2-hunter2";
      const { userId } = await createUserWithPreferences(db, auth, {
        email: "hash@svc.test",
        password: plaintext,
      });
      const accts = await accountRows(userId);
      expect(accts).toHaveLength(1);
      const hash = accts[0]!.password;
      // SECRETS RULE: assert shape/inequality via booleans and lengths ONLY — a toBe/toEqual failure
      // would print the hash bytes into the report.
      expect(typeof hash).toBe("string");
      expect((hash ?? "").length).toBeGreaterThan(0);
      expect(hash === plaintext).toBe(false);
      expect(hash!.includes(plaintext)).toBe(false);
    });

    it("round-trips the credential: signInEmail resolves with the EXACT created password and rejects a wrong one", async () => {
      // The shape-only hash test above cannot see a silently-mangled credential (e.g. hashing an
      // upper-cased password) — only verifying against the stored hash can. requireEmailVerification
      // is false, so unverified sign-in is permitted; runs entirely over the same PGlite instance.
      // 3 scrypt ops total (1 hash + 2 verifies). No hash/token values asserted or printed.
      const email = "roundtrip@svc.test";
      const password = "pw-roundtrip-ok";
      const { userId } = await createUserWithPreferences(db, auth, { email, password });

      const signedIn = await auth.api.signInEmail({ body: { email, password } });
      expect(signedIn.user.id).toBe(userId);

      const err = await captureRejection(
        auth.api.signInEmail({ body: { email, password: "pw-roundtrip-NO" } }),
      );
      expect(err).not.toBeNull();
      // Plain JS throw (better-auth APIError, no SQL failure) → exact-message matching.
      expect(err!.message).toBe("Invalid email or password");
    });

    it("mints no session row — autoSignIn:false", async () => {
      await createUserWithPreferences(db, auth, {
        email: "nosession@svc.test",
        password: "pw-longenough-1",
      });
      // autoSignIn:true would mint a session row here (headless CLI seeds must not).
      expect(await allSessionRows()).toHaveLength(0);
    });
  });

  describe("createUserWithPreferences — emailVerified flip", () => {
    it("markVerified:true flips ONLY the new user — a seeded unverified bystander user stays false", async () => {
      // BYSTANDER for the scoped UPDATE at service.ts:56: with a single user row, a WHERE-less update
      // is observationally identical to the scoped one.
      const bystander = await seedUser(90, { email: "bystander@svc.test", emailVerified: false });

      const { userId } = await createUserWithPreferences(db, auth, {
        email: "verified@svc.test",
        password: "pw-longenough-1",
        markVerified: true,
      });

      expect((await userById(userId)).emailVerified).toBe(true);
      expect((await userById(bystander)).emailVerified).toBe(false);
    });

    it("markVerified omitted leaves emailVerified false (signUpEmail hardcodes false)", async () => {
      const { userId } = await createUserWithPreferences(db, auth, {
        email: "unverified@svc.test",
        password: "pw-longenough-1",
      });
      expect((await userById(userId)).emailVerified).toBe(false);
    });
  });

  describe("createUserWithPreferences — prefs seeding", () => {
    it("seeds the 1:1 prefs row with a 64-hex unsubscribe token", async () => {
      const { userId } = await createUserWithPreferences(db, auth, {
        email: "token@svc.test",
        password: "pw-longenough-1",
      });
      // generateUnsubscribeToken has no injection seam — shape-only (64 lowercase hex), never a value.
      expect((await prefsRow(userId)).unsubscribeToken).toMatch(TOKEN_RE);
    });

    it("applies overrides (locationMode/recencyDays/digestCadence) while keeping untouched defaults (digestEnabled true, locations [])", async () => {
      const { userId } = await createUserWithPreferences(db, auth, {
        email: "overrides@svc.test",
        password: "pw-longenough-1",
        prefs: { locationMode: "onsite_only", recencyDays: 7, digestCadence: "daily" },
      });
      const prefs = await prefsRow(userId);
      // toRow drops `undefined` keys — the three passed overrides land, everything else stays default.
      expect(prefs.locationMode).toBe("onsite_only");
      expect(prefs.recencyDays).toBe(7);
      expect(prefs.digestCadence).toBe("daily");
      expect(prefs.digestEnabled).toBe(true);
      expect(prefs.locations).toEqual([]);
    });

    it("no prefs → pure column defaults incl. digestApprovedAt NULL (fail-closed permit), recencyDays 14, cadence weekly, locationMode any", async () => {
      const { userId } = await createUserWithPreferences(db, auth, {
        email: "defaults@svc.test",
        password: "pw-longenough-1",
      });
      const prefs = await prefsRow(userId);
      expect(prefs.digestEnabled).toBe(true);
      expect(prefs.digestCadence).toBe("weekly");
      expect(prefs.locations).toEqual([]);
      expect(prefs.recencyDays).toBe(14);
      expect(prefs.locationMode).toBe("any");
      expect(prefs.exclusions).toEqual([]);
      expect(prefs.dealbreakers).toEqual([]);
      expect(prefs.minSalary).toBeNull();
      expect(prefs.maxSalary).toBeNull();
      expect(prefs.yoeMin).toBeNull();
      expect(prefs.yoeMax).toBeNull();
      // The operator send permit MUST start NULL — a creation-time default would fail-OPEN the digest gate.
      expect(prefs.digestApprovedAt).toBeNull();
      expect(prefs.digestSuppressedAt).toBeNull();
      expect(prefs.digestBounceStatus).toBe("none");
    });
  });

  describe("createUserWithPreferences — error paths (the documented non-atomic contract)", () => {
    it("rejects an untrimmed/malformed email at better-auth body validation and writes NO rows", async () => {
      const err = await captureRejection(
        createUserWithPreferences(db, auth, {
          email: " padded@svc.test ", // z.email() rejects leading/trailing spaces BEFORE any insert
          password: "pw-longenough-1",
        }),
      );
      expect(err).not.toBeNull();
      // Plain JS throw (thrown before SQL) → exact-message matching. VERIFIED live: the route's
      // better-call BODY-SCHEMA validation (z.email() on body.email) rejects first — the handler's
      // own BASE_ERROR_CODES.INVALID_EMAIL ("Invalid email") is never reached via auth.api.
      expect(err!.message).toBe("[body.email] Invalid email address");
      expect(await allUserRows()).toHaveLength(0);
      expect(await db.select({ id: account.id }).from(account)).toHaveLength(0);
      expect(await allPrefsRows()).toHaveLength(0);
    });

    it("rejects a 7-char password with PASSWORD_TOO_SHORT and writes NO rows", async () => {
      const err = await captureRejection(
        createUserWithPreferences(db, auth, {
          email: "shortpw@svc.test",
          password: "seven77", // 7 chars < better-auth's default minPasswordLength 8
        }),
      );
      expect(err).not.toBeNull();
      expect(err!.message).toBe("Password too short");
      expect(await allUserRows()).toHaveLength(0);
      expect(await db.select({ id: account.id }).from(account)).toHaveLength(0);
      expect(await allPrefsRows()).toHaveLength(0);
    });

    it("duplicate email: signUpEmail resolves with a PHANTOM uuid (generic duplicate response under autoSignIn:false) and the prefs insert FK-rejects — existing user untouched", async () => {
      // The existing user is created UNVERIFIED so "emailVerified unchanged" is load-bearing: the
      // phantom-uuid markVerified UPDATE must match 0 rows — an unscoped update would flip this true.
      const { userId: existing } = await createUserWithPreferences(db, auth, {
        email: "dupe@svc.test",
        password: "pw-first-0000",
        prefs: { recencyDays: 7 },
      });
      const prefsBefore = await prefsRow(existing);

      const err = await captureRejection(
        createUserWithPreferences(db, auth, {
          email: "dupe@svc.test",
          password: "pw-second-000",
          markVerified: true,
        }),
      );

      // OBSERVABLE contract only (better-auth 1.6.14: generic-duplicate → phantom uuid → the prefs
      // INSERT violates user_preferences_user_id_user_id_fk). drizzle 0.45 wraps the PG error as
      // "Failed query: …" — the 23503 text lives on err.cause, never the wrapper message.
      expect(err).not.toBeNull();
      expect(String(err!.cause ?? err)).toMatch(/foreign key|violates/i);

      // The pre-existing user is untouched: exactly one user row, still unverified.
      const users = await db.select().from(user);
      expect(users).toHaveLength(1);
      expect(users[0]!.id).toBe(existing);
      expect(users[0]!.emailVerified).toBe(false);
      // Prefs row byte-identical (token NOT rotated — full-row equality covers it), no orphan row for
      // the phantom id (the FK rejection is what guarantees that).
      expect(await prefsRow(existing)).toEqual(prefsBefore);
      expect(await allPrefsRows()).toHaveLength(1);
      // Exactly one account row (the original), no session row minted by the duplicate attempt.
      expect(await accountRows(existing)).toHaveLength(1);
      expect(await db.select({ id: account.id }).from(account)).toHaveLength(1);
      expect(await allSessionRows()).toHaveLength(0);
    });

    it("poisoned db failing the prefs INSERT: user+account rows persist, no prefs row, sentinel error propagates — the non-atomic step-3 contract", async () => {
      const sentinel = new Error("prefs-insert-poisoned");
      await expect(
        createUserWithPreferences(poisonDb(db, "insert", sentinel), auth, {
          email: "halfa@svc.test",
          password: "pw-longenough-1",
          markVerified: true,
        }),
      ).rejects.toBe(sentinel);

      // signUpEmail committed through auth's own REAL db reference — the half-created user persists.
      const rows = await db.select().from(user).where(eq(user.email, "halfa@svc.test"));
      expect(rows).toHaveLength(1);
      // emailVerified true = step 2 (the verify UPDATE) ran BEFORE step 3 failed — order + persistence.
      expect(rows[0]!.emailVerified).toBe(true);
      expect(await accountRows(rows[0]!.id)).toHaveLength(1);
      expect(await allPrefsRows()).toHaveLength(0);
    });

    it("poisoned db failing the verify UPDATE: user+account persist, prefs insert never attempted (step order), sentinel propagates", async () => {
      const sentinel = new Error("verify-update-poisoned");
      await expect(
        createUserWithPreferences(poisonDb(db, "update", sentinel), auth, {
          email: "halfb@svc.test",
          password: "pw-longenough-1",
          markVerified: true,
        }),
      ).rejects.toBe(sentinel);

      const rows = await db.select().from(user).where(eq(user.email, "halfb@svc.test"));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.emailVerified).toBe(false);
      expect(await accountRows(rows[0]!.id)).toHaveLength(1);
      // `insert` is NOT poisoned here — a prefs row would exist if the service kept going after the
      // step-2 throw, so its absence proves the step order, not just the propagation.
      expect(await allPrefsRows()).toHaveLength(0);
    });

    it("recovery: getOrCreateUserByEmail on the half-created user backfills the prefs row and returns the same userId", async () => {
      const sentinel = new Error("prefs-insert-poisoned");
      await expect(
        createUserWithPreferences(poisonDb(db, "insert", sentinel), auth, {
          email: "recover@svc.test",
          password: "pw-longenough-1",
          markVerified: true,
        }),
      ).rejects.toBe(sentinel);
      const half = (await db.select().from(user).where(eq(user.email, "recover@svc.test")))[0]!;
      expect(await allPrefsRows()).toHaveLength(0); // precondition: half-created, prefs missing

      // The documented retry-idempotency of the prefs step: found path + getOrCreatePreferences.
      const { userId } = await getOrCreateUserByEmail(db, auth, "recover@svc.test");

      expect(userId).toBe(half.id);
      expect((await prefsRow(userId)).unsubscribeToken).toMatch(TOKEN_RE);
      expect(await allUserRows()).toHaveLength(1); // recovered, not duplicated
    });
  });

  describe("getOrCreateUserByEmail — idempotency (case/space-insensitive, no duplicate)", () => {
    it("creates a NEW verified user with the normalized email, opts.prefs applied, and a prefs row with a 64-hex token", async () => {
      const { userId } = await getOrCreateUserByEmail(db, auth, " NewUser@Svc.Test ", {
        prefs: { recencyDays: 7, digestCadence: "daily" },
      });
      const row = await userById(userId);
      // trim+lowercase happens BEFORE the create, so the stored email is fully normalized.
      expect(row.email).toBe("newuser@svc.test");
      // The create branch passes markVerified:true (ingest-created users are email-verified by fiat).
      expect(row.emailVerified).toBe(true);
      const prefs = await prefsRow(userId);
      expect(prefs.unsubscribeToken).toMatch(TOKEN_RE);
      expect(prefs.recencyDays).toBe(7);
      expect(prefs.digestCadence).toBe("daily");
      expect(prefs.digestEnabled).toBe(true); // untouched default
      // A real credential account exists (throwaway random password path, ≥ 8-char min).
      expect(await accountRows(userId)).toHaveLength(1);
    });

    it("second call with an upper-cased padded variant returns the SAME userId and leaves exactly one user row", async () => {
      const first = await getOrCreateUserByEmail(db, auth, "same@svc.test");
      const again = await getOrCreateUserByEmail(db, auth, " SAME@SVC.TEST ");
      expect(again.userId).toBe(first.userId);
      // user_email_uq invariant: one row total — a broken normalization would have created a second
      // user under a different raw email, which this whole-table count catches.
      expect(await allUserRows()).toHaveLength(1);
    });

    it("existing user with a prefs row: token NOT rotated and prefs untouched even when opts.prefs is passed", async () => {
      const existing = await seedUser(10, { email: "kept@svc.test" });
      await seedPrefs(existing, {
        unsubscribeToken: "seed-token-kept",
        recencyDays: 30,
        digestCadence: "monthly",
      });
      const before = await prefsRow(existing);

      const { userId } = await getOrCreateUserByEmail(db, auth, "kept@svc.test", {
        prefs: { recencyDays: 3, digestCadence: "daily" },
      });

      expect(userId).toBe(existing);
      // onConflictDoNothing: the FULL row is byte-identical — token unrotated AND opts.prefs NOT
      // applied on the found path (recencyDays stays 30, not 3).
      expect(await prefsRow(existing)).toEqual(before);
    });

    it("existing user WITHOUT a prefs row: backfills with pure column DEFAULTS — opts.prefs deliberately ignored on the backfill branch (current behavior)", async () => {
      const existing = await seedUser(11, { email: "backfill@svc.test" });

      // MANGLED variant on purpose: this is the only found-path call with a non-normalized email, so
      // the lookup normalization at service.ts:82 is load-bearing HERE — a raw-email lookup would miss,
      // fall into the create path, converge through the lost-race catch, and silently SKIP the
      // backfill (prefsRow() below would then find 0 rows).
      const { userId } = await getOrCreateUserByEmail(db, auth, " BACKFILL@SVC.TEST ", {
        prefs: { recencyDays: 3, digestCadence: "daily", locationMode: "onsite_only" },
      });

      expect(userId).toBe(existing);
      const prefs = await prefsRow(existing);
      // PINS CURRENT BEHAVIOR: service.ts's found-path backfill omits `prefs:` entirely, so the
      // passed opts land NOWHERE — column defaults win. Flagged in the PR, not changed here.
      expect(prefs.recencyDays).toBe(14);
      expect(prefs.digestCadence).toBe("weekly");
      expect(prefs.locationMode).toBe("any");
      expect(prefs.unsubscribeToken).toMatch(TOKEN_RE);
    });

    it("bystander user prefs (distinct token) untouched by another email getOrCreate", async () => {
      // Target has NO prefs row (the backfill INSERT will fire); the bystander HAS one — with a single
      // candidate row an unscoped write would be invisible, so the bystander is what makes the
      // userId-scoping of the backfill observable.
      const target = await seedUser(12, { email: "target@svc.test" });
      const bystander = await seedUser(13, { email: "bystander2@svc.test" });
      await seedPrefs(bystander, { unsubscribeToken: "seed-token-bystander", recencyDays: 30 });
      const bystanderBefore = await prefsRow(bystander);

      const { userId } = await getOrCreateUserByEmail(db, auth, "target@svc.test");

      expect(userId).toBe(target);
      expect((await prefsRow(target)).userId).toBe(target); // backfill landed on the target...
      expect(await prefsRow(bystander)).toEqual(bystanderBefore); // ...and ONLY on the target
    });
  });

  describe("getOrCreateUserByEmail — lost-race recovery", () => {
    it("stub auth plants the winner row then fails: the catch re-resolves and returns the WINNER id with no duplicate", async () => {
      const winnerId = uid(50);
      // The honest race seam: the real better-auth cannot lose a race deterministically in-process, so
      // signUpEmail is stubbed to (a) commit the RACING process's user row via the real db, then
      // (b) return better-auth 1.6.14's generic-duplicate shape — a phantom uuid that exists in NO
      // table. The service's prefs insert then FK-rejects and the catch must re-resolve to the winner.
      const stubAuth = {
        api: {
          signUpEmail: async () => {
            await db.insert(user).values({
              id: winnerId,
              name: "Race Winner",
              email: "race@svc.test",
              emailVerified: true,
            });
            return { token: null, user: { id: crypto.randomUUID() } };
          },
        },
      } as unknown as Auth;

      const { userId } = await getOrCreateUserByEmail(db, stubAuth, " RACE@Svc.Test ");

      expect(userId).toBe(winnerId);
      const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, "race@svc.test"));
      expect(rows).toHaveLength(1);
    });

    it("stub auth fails and the email still resolves to nothing: the ORIGINAL sentinel error rethrows (same instance)", async () => {
      const sentinel = new Error("signup-lost-no-winner");
      const stubAuth = {
        api: {
          signUpEmail: async (): Promise<never> => {
            throw sentinel;
          },
        },
      } as unknown as Auth;

      // rejects.toBe = IDENTITY, not just message — the catch must rethrow `err` itself, never a rewrap.
      await expect(getOrCreateUserByEmail(db, stubAuth, "gone@svc.test")).rejects.toBe(sentinel);
      expect(await allUserRows()).toHaveLength(0);
    });
  });

  describe("findUserIdByEmail — normalized lookup", () => {
    it("resolves the id for a stored lowercase email", async () => {
      const target = await seedUser(20, { email: "findme@svc.test" });
      // A second user makes the eq() selective — a WHERE-less limit-1 read could return either row.
      await seedUser(21, { email: "other@svc.test" });
      expect(await findUserIdByEmail(db, "findme@svc.test")).toBe(target);
    });

    it('trims + lowercases the query — " USER@X.COM " finds user@x.com', async () => {
      const target = await seedUser(22, { email: "user@x.com" });
      expect(await findUserIdByEmail(db, "  USER@X.COM  ")).toBe(target);
    });

    it("returns null for an unknown email", async () => {
      await seedUser(23, { email: "present@svc.test" });
      expect(await findUserIdByEmail(db, "absent@svc.test")).toBeNull();
    });

    it("does NOT match a raw-seeded MixedCase stored email — creation-time normalization is the invariant, lookup is exact eq", async () => {
      // Raw seed BYPASSES the service's creation-time normalization — such a row is unreachable by
      // design: the query side lowers to 'upper@x.com', and eq() is exact (not ILIKE), so neither the
      // original casing nor the lowered form finds it.
      await seedUser(24, { email: "Upper@X.com" });
      expect(await findUserIdByEmail(db, "Upper@X.com")).toBeNull();
      expect(await findUserIdByEmail(db, "upper@x.com")).toBeNull();
    });
  });
});
