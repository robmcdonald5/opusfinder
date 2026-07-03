import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  alreadyShownJobIds,
  alreadyShownSignatures,
  deleteUserDigestForRun,
  dropDigestItemsAndRecount,
  getDigestApplyTargets,
  getDigestEmailPayload,
  getJobSnapshots,
  getLatestDigestForUser,
  insertDigest,
  insertDigestItems,
  listDigestRecipients,
  markDigestConsidered,
  recordDigestDeliveryOutcome,
  recordDigestSendFailure,
  recordDigestSent,
  startDigestRun,
  type NewDigestItem,
} from "@opusfinder/db/repos";
import {
  companies,
  digestItems,
  digestRuns,
  digests,
  jobs,
  user,
  userCvFiles,
  userPreferences,
  userProfiles,
  type DigestBounceStatus,
} from "@opusfinder/db/schema";
import { companySlug, jobId, type DigestCadence, type UserId } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";

import { NUL } from "./sql";

// What this file proves: the digests repo's Postgres SEMANTICS under real PGlite — the recipient
// eligibility gates + cadence windows (real SQL now() interval math), the shown-history anti-joins,
// the persist-step writes (unique (user, run) guard, FK cascade, NUL strip, the CTE delete+recount),
// the email render read (COALESCE snapshot→live, LEFT-join prune survival, the app-side active
// filter, the two empty shapes), and the delivery-state writes. NOT this file's job: the digest_runs
// start/finish lifecycle (owned by runs.integration.test.ts — startDigestRun appears here ONLY as FK
// seeding for digests.digest_run_id) and SQL text/param binding (the render()/stubExecDb unit seams).

/** Explicit monotonically-ascending uuid — Postgres orders uuid bytewise, so ORDER BY user.id /
 *  gt(afterId) assertions are deterministic (never rely on gen_random_uuid insertion order). */
function uid(n: number): UserId {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as UserId;
}

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3_600_000);
}

function daysAgo(d: number): Date {
  return hoursAgo(d * 24);
}

interface RecipientOverrides {
  name?: string;
  email?: string;
  emailVerified?: boolean;
  digestEnabled?: boolean;
  digestCadence?: DigestCadence;
  digestApprovedAt?: Date | null;
  digestSuppressedAt?: Date | null;
  digestBounceStatus?: DigestBounceStatus;
  lastDigestSentAt?: Date | null;
  lastDigestEmailId?: string | null;
  /** undefined → a real 1024-dim vector; null → a user_profiles row with NULL embedding. */
  embedding?: number[] | null;
  /** false → NO user_profiles row at all (the INNER JOIN gate case). */
  profileRow?: boolean;
}

describe("digests repo — recipient gates, shown-history anti-joins, persist/render/delivery writes (integration: real PGlite semantics)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;
  let extSeq = 0; // unique jobs.(source, external_id) across the whole file

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    // Truncate ONLY the tables this file touches; RESTART IDENTITY keeps seeded ids deterministic.
    // The reserved "user" table is interpolated as a drizzle table object so quoting is never hand-rolled.
    await db.execute(
      sql`TRUNCATE TABLE ${digestItems}, ${digests}, ${digestRuns}, ${userPreferences}, ${userProfiles}, ${userCvFiles}, ${jobs}, ${companies}, ${user} RESTART IDENTITY CASCADE`,
    );
  });
  afterAll(async () => {
    // Optional-chained: if beforeAll's createTestDb() rejected, a bare close() would bury the real
    // failure under a secondary TypeError. Drains the WASM handle → clean Windows teardown.
    await close?.();
  });

  /** The 4-table eligible-recipient graph: user → user_cv_files → user_profiles → user_preferences.
   *  Defaults are FULLY eligible (verified, enabled, approved, unsuppressed, embedded) so every gate
   *  test is a one-field variation. */
  async function seedRecipient(n: number, overrides: RecipientOverrides = {}): Promise<UserId> {
    const userId = uid(n);
    await db.insert(user).values({
      id: userId,
      name: overrides.name ?? `User ${n}`,
      email: overrides.email ?? `user${n}@test.local`,
      emailVerified: overrides.emailVerified ?? true,
    });
    // user_profiles.source_cv_file_id is a NOT NULL FK — the profile needs a backing upload row.
    const cvRows = await db
      .insert(userCvFiles)
      .values({
        userId,
        r2OriginalKey: `cv/original/${n}.pdf`,
        filename: `cv-${n}.pdf`,
        contentType: "application/pdf",
        byteSize: 1024,
      })
      .returning({ id: userCvFiles.id });
    const cv = cvRows[0];
    if (!cv) throw new Error("seedRecipient: user_cv_files insert returned no row");
    if (overrides.profileRow !== false) {
      await db.insert(userProfiles).values({
        userId,
        structured: { summary: "backend engineer", skills: ["ts"], targetRoles: ["Platform"] },
        embedding:
          overrides.embedding === undefined ? new Array<number>(1024).fill(0.1) : overrides.embedding,
        sourceCvFileId: cv.id,
      });
    }
    await db.insert(userPreferences).values({
      userId,
      unsubscribeToken: `tok-${n}`, // NOT NULL UNIQUE — one per user
      digestEnabled: overrides.digestEnabled ?? true,
      digestCadence: overrides.digestCadence ?? "daily",
      digestApprovedAt:
        overrides.digestApprovedAt === undefined ? new Date() : overrides.digestApprovedAt,
      digestSuppressedAt: overrides.digestSuppressedAt ?? null,
      digestBounceStatus: overrides.digestBounceStatus ?? "none",
      lastDigestSentAt: overrides.lastDigestSentAt ?? null,
      lastDigestEmailId: overrides.lastDigestEmailId ?? null,
    });
    return userId;
  }

  async function seedCompany(slug = "acme"): Promise<number> {
    const rows = await db
      .insert(companies)
      .values({ slug: companySlug(slug), source: "greenhouse" })
      .returning({ id: companies.id });
    const row = rows[0];
    if (!row) throw new Error("seedCompany returned no row");
    return row.id;
  }

  async function seedJob(
    companyId: number,
    overrides: Partial<typeof jobs.$inferInsert> = {},
  ): Promise<number> {
    extSeq += 1;
    const rows = await db
      .insert(jobs)
      .values({
        externalId: jobId(`ext-${extSeq}`),
        companyId,
        source: "greenhouse",
        title: `Job ${extSeq}`,
        descriptionText: "description body",
        locations: ["NYC"],
        remote: false,
        applyUrl: `https://live.test/${extSeq}`,
        ...overrides,
      })
      .returning({ id: jobs.id });
    const row = rows[0];
    if (!row) throw new Error("seedJob returned no row");
    return row.id;
  }

  /** startDigestRun FIRST (digests.digest_run_id FK is NO ACTION — the insert rejects without a
   *  parent), then insertDigest — the persist step's real call order, reused as seeding. */
  async function seedDigestForUser(
    userId: UserId,
    opts: { itemCount?: number; counts?: Record<string, number> } = {},
  ): Promise<{ runId: number; digestId: number }> {
    const runId = await startDigestRun(db, "manual");
    const { id: digestId } = await insertDigest(db, {
      userId,
      digestRunId: runId,
      itemCount: opts.itemCount ?? 1,
      counts: opts.counts ?? {},
    });
    return { runId, digestId };
  }

  /** A NewDigestItem with a full snapshot (the interface makes snapshot fields non-optional). */
  function item(forJobId: number, rank: number, overrides: Partial<NewDigestItem> = {}): NewDigestItem {
    return {
      jobId: forJobId,
      rank,
      score: 0.5, // dyadic — float4 round-trips it exactly
      reason: `reason ${rank}`,
      jobTitle: `Snapshot Job ${rank}`,
      companySlug: "acme",
      applyUrl: `https://snap.test/${forJobId}`,
      locations: ["Remote - US"],
      remote: true,
      ...overrides,
    };
  }

  async function readDigest(id: number) {
    const rows = await db.select().from(digests).where(eq(digests.id, id));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function readPrefs(userId: UserId) {
    const rows = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  describe("listDigestRecipients — eligibility gates, cadence windows, keyset", () => {
    it("drops a user whose digest_approved_at is NULL — the fail-closed send permit filters before any paid spend", async () => {
      const a = await seedRecipient(1);
      await seedRecipient(2, { digestApprovedAt: null });
      // B satisfies every OTHER gate, so B appearing here means the isNotNull(digestApprovedAt) clause was dropped.
      expect(await listDigestRecipients(db, { limit: 10 })).toEqual([{ userId: a }]);
    });

    it("drops a user with digest_enabled=false", async () => {
      const a = await seedRecipient(1);
      await seedRecipient(2, { digestEnabled: false });
      // Single-variable seed: only eq(digestEnabled, true) can exclude B.
      expect(await listDigestRecipients(db, { limit: 10 })).toEqual([{ userId: a }]);
    });

    it("drops a user whose email is unverified", async () => {
      const a = await seedRecipient(1);
      await seedRecipient(2, { emailVerified: false });
      // Single-variable seed: only eq(user.emailVerified, true) can exclude B.
      expect(await listDigestRecipients(db, { limit: 10 })).toEqual([{ userId: a }]);
    });

    it("drops a suppressed user (digest_suppressed_at set)", async () => {
      const a = await seedRecipient(1);
      await seedRecipient(2, { digestSuppressedAt: new Date() });
      // Single-variable seed: only isNull(digestSuppressedAt) can exclude B.
      expect(await listDigestRecipients(db, { limit: 10 })).toEqual([{ userId: a }]);
    });

    it("drops a NULL-embedding profile AND a user with no user_profiles row — the embedding gate + INNER JOIN", async () => {
      const a = await seedRecipient(1);
      await seedRecipient(2, { embedding: null }); // row exists, embedding NULL
      await seedRecipient(3, { profileRow: false }); // no user_profiles row at all
      // B reds only if isNotNull(userProfiles.embedding) is dropped; C reds only if the innerJoin
      // weakens to a left join — two independent mutations, one seed.
      expect(await listDigestRecipients(db, { limit: 10 })).toEqual([{ userId: a }]);
    });

    it("cadenceDue=true applies the daily 20h window — stale send is due, recent is not, never-sent is always due", async () => {
      // Generous 25h/1h offsets — the predicate compares against SQL now(), which cannot be frozen,
      // so seeding near the 20h boundary would be flaky by construction.
      const a = await seedRecipient(1, { digestCadence: "daily", lastDigestSentAt: hoursAgo(25) });
      await seedRecipient(2, { digestCadence: "daily", lastDigestSentAt: hoursAgo(1) });
      const c = await seedRecipient(3, { digestCadence: "daily", lastDigestSentAt: null });
      // B passes every static gate — only the daily `sent < now() - interval '20 hours'` branch excludes
      // it; C reds if the `sent IS NULL OR` arm is removed; A reds if the whole branch vanishes.
      expect(await listDigestRecipients(db, { limit: 10, cadenceDue: true })).toEqual([
        { userId: a },
        { userId: c },
      ]);
    });

    it("weekly is 6 days and monthly is 28 — each cadence is evaluated only against its own branch", async () => {
      const w1 = await seedRecipient(1, { digestCadence: "weekly", lastDigestSentAt: daysAgo(7) });
      // W2 at 1d is PAST the daily 20h window — it reds if a weekly user is evaluated on the daily interval.
      await seedRecipient(2, { digestCadence: "weekly", lastDigestSentAt: daysAgo(1) });
      const m1 = await seedRecipient(3, { digestCadence: "monthly", lastDigestSentAt: daysAgo(29) });
      // M2 at 10d is PAST the weekly 6d window — it reds if a monthly user hits the weekly interval.
      await seedRecipient(4, { digestCadence: "monthly", lastDigestSentAt: daysAgo(10) });
      expect(await listDigestRecipients(db, { limit: 10, cadenceDue: true })).toEqual([
        { userId: w1 },
        { userId: m1 },
      ]);
    });

    it("cadenceDue omitted applies NO cadence filter — a just-sent user is still returned (the manual --all sweep)", async () => {
      const a = await seedRecipient(1, { digestCadence: "daily", lastDigestSentAt: hoursAgo(1) });
      // If the `if (opts.cadenceDue)` guard regressed to always-push the predicate, this user vanishes.
      expect(await listDigestRecipients(db, { limit: 10 })).toEqual([{ userId: a }]);
    });

    it("keyset-paginates by user.id — limit caps the page and afterId resumes strictly-greater without repeats", async () => {
      const u1 = await seedRecipient(1);
      const u2 = await seedRecipient(2);
      const u3 = await seedRecipient(3);
      // Removing .limit makes page 1 length 3; removing .orderBy(user.id) risks a nondeterministic
      // order against this exact-sequence assertion.
      expect(await listDigestRecipients(db, { limit: 2 })).toEqual([{ userId: u1 }, { userId: u2 }]);
      // Removing gt(user.id, afterId) restarts page 2 at u1.
      expect(await listDigestRecipients(db, { afterId: u2, limit: 2 })).toEqual([{ userId: u3 }]);
    });
  });

  describe("alreadyShownJobIds / alreadyShownSignatures — the next-run dedup anti-joins", () => {
    it("returns the caller's DISTINCT shown job ids only — no cross-user leak, one entry for a twice-shown job", async () => {
      const a = await seedRecipient(1);
      const b = await seedRecipient(2);
      const companyId = await seedCompany();
      const j1 = await seedJob(companyId);
      const j2 = await seedJob(companyId);
      const j3 = await seedJob(companyId);
      const dA1 = await seedDigestForUser(a, { itemCount: 2 });
      await insertDigestItems(db, dA1.digestId, a, [item(j1, 1), item(j2, 2)]);
      const dA2 = await seedDigestForUser(a, { itemCount: 1 });
      await insertDigestItems(db, dA2.digestId, a, [item(j1, 1)]); // j1 shown AGAIN in a second digest
      const dB = await seedDigestForUser(b, { itemCount: 1 });
      await insertDigestItems(db, dB.digestId, b, [item(j3, 1)]);

      // j3 appearing in A's set = the eq(digestItems.userId) where was dropped; a duplicated j1 =
      // selectDistinct degraded to select.
      expect((await alreadyShownJobIds(db, a)).sort((x, y) => x - y)).toEqual([j1, j2]);
      expect(await alreadyShownJobIds(db, b)).toEqual([j3]);
    });

    it("keeps a CLOSED job's signature, drops NULL signatures + dangling job_ids, and dedups a twice-shown job", async () => {
      const a = await seedRecipient(1);
      const companyId = await seedCompany();
      const jClosed = await seedJob(companyId, {
        lifecycleState: "closed",
        contentSignature: "sig-closed",
      });
      const jActive = await seedJob(companyId, { contentSignature: "sig-active" });
      const jNullSig = await seedJob(companyId); // content_signature stays NULL
      const { digestId } = await seedDigestForUser(a, { itemCount: 5 });
      // 999999 has NO jobs row — legal (digest_items.job_id FK was deliberately dropped). Its
      // contributing nothing is enforced REDUNDANTLY (INNER JOIN + isNotNull + the app-side null
      // filter), so no single clause is the discriminator — the observable behavior is the contract.
      await insertDigestItems(db, digestId, a, [
        item(jClosed, 1),
        item(jActive, 2),
        item(jNullSig, 3),
        item(999999, 4),
        item(jActive, 5), // duplicate job → selectDistinct must collapse it
      ]);
      // Cross-user tripwire: B's shown history must never leak into A's anti-join — an unscoped
      // query (missing the userId WHERE) would suppress jobs A has NEVER seen from A's digest.
      // alreadyShownJobIds has its own leak test; this pins the signatures fn's separate WHERE.
      const b = await seedRecipient(2);
      const jOther = await seedJob(companyId, { contentSignature: "sig-other" });
      const dB = await seedDigestForUser(b, { itemCount: 1 });
      await insertDigestItems(db, dB.digestId, b, [item(jOther, 1)]);

      const sigs = await alreadyShownSignatures(db, a);
      // Length 2 = NULL-signature and dangling rows contributed nothing AND the dup collapsed.
      expect(sigs).toHaveLength(2);
      // 'sig-closed' present = NO lifecycle filter (the documented deliberate absence — a well-meaning
      // "add active filter" refactor would break the repost cooldown for soft-closed predecessors).
      // The set equality also proves B's 'sig-other' did NOT leak in.
      expect(new Set(sigs)).toEqual(new Set(["sig-closed", "sig-active"]));
      expect(await alreadyShownSignatures(db, b)).toEqual(["sig-other"]);
    });
  });

  describe("persist-step writes — header uniqueness, item hygiene, snapshots, delete/drop", () => {
    it("insertDigest returns an id; a second insert for the same (user, run) rejects; a different run succeeds", async () => {
      const a = await seedRecipient(1);
      const r1 = await startDigestRun(db, "manual");
      const first = await insertDigest(db, { userId: a, digestRunId: r1, itemCount: 2, counts: {} });
      expect(first.id).toBeGreaterThan(0);
      // The digests_user_id_digest_run_id_uq index is the double-write guard — if a migration drops
      // or widens it, this expected rejection stops happening (rejection === null below).
      const rejection = await insertDigest(db, {
        userId: a,
        digestRunId: r1,
        itemCount: 2,
        counts: {},
      }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(rejection).not.toBeNull();
      // Drizzle wraps the driver error as "Failed query: ..." — the 23505 unique-violation text lives
      // on err.cause, so match the cause chain, not the wrapper message.
      expect(String(rejection!.cause ?? rejection)).toMatch(/unique|duplicate/i);
      // Same user on a DIFFERENT run succeeds — the guard is the composite pair, not user_id alone.
      const r2 = await startDigestRun(db, "manual");
      const second = await insertDigest(db, { userId: a, digestRunId: r2, itemCount: 1, counts: {} });
      expect(second.id).toBeGreaterThan(first.id);
    });

    it("deleteUserDigestForRun deletes only the (user, run) digest, cascades its items, and no-ops on repeat", async () => {
      const a = await seedRecipient(1);
      const b = await seedRecipient(2);
      const companyId = await seedCompany();
      const j1 = await seedJob(companyId);
      const r1 = await startDigestRun(db, "manual");
      const r2 = await startDigestRun(db, "manual");
      const dA1 = await insertDigest(db, { userId: a, digestRunId: r1, itemCount: 2, counts: {} });
      await insertDigestItems(db, dA1.id, a, [item(j1, 1), item(j1, 2)]);
      const dA2 = await insertDigest(db, { userId: a, digestRunId: r2, itemCount: 1, counts: {} });
      await insertDigestItems(db, dA2.id, a, [item(j1, 1)]);
      const dB1 = await insertDigest(db, { userId: b, digestRunId: r1, itemCount: 1, counts: {} });
      await insertDigestItems(db, dB1.id, b, [item(j1, 1)]);

      await deleteUserDigestForRun(db, a, r1);

      // (B, r1) surviving = the userId half of the AND held; (A, r2) surviving = the digestRunId half held.
      const remaining = await db
        .select({ id: digests.id, userId: digests.userId, digestRunId: digests.digestRunId })
        .from(digests)
        .orderBy(digests.id);
      expect(remaining).toEqual([
        { id: dA2.id, userId: a, digestRunId: r2 },
        { id: dB1.id, userId: b, digestRunId: r1 },
      ]);
      // Orphan items here = the digest_items FK ON DELETE CASCADE regressed.
      expect(await db.select().from(digestItems).where(eq(digestItems.digestId, dA1.id))).toHaveLength(0);
      expect(await db.select().from(digestItems).where(eq(digestItems.digestId, dA2.id))).toHaveLength(1);
      expect(await db.select().from(digestItems).where(eq(digestItems.digestId, dB1.id))).toHaveLength(1);
      // No-op path: a second delete for the same (user, run) must not throw.
      await expect(deleteUserDigestForRun(db, a, r1)).resolves.toBeUndefined();
    });

    it("insertDigestItems strips NUL from reason + every snapshot text field, denormalizes userId; empty list is a no-op", async () => {
      const a = await seedRecipient(1);
      const companyId = await seedCompany();
      const j1 = await seedJob(companyId);
      const { digestId } = await seedDigestForUser(a);
      // NUL is built at RUNTIME (repos/sql.ts String.fromCharCode(0)) — a literal escape in this
      // source would be decoded to a real byte by the file-writing tool and corrupt the file.
      await insertDigestItems(db, digestId, a, [
        {
          jobId: j1,
          rank: 1,
          score: 0.5,
          reason: `why${NUL}kept`,
          jobTitle: `Sr${NUL}Eng`,
          companySlug: `ac${NUL}me`,
          applyUrl: `https://x.test/${NUL}a`,
          locations: [`Rem${NUL}ote`],
          remote: true,
        },
      ]);
      const rows = await db.select().from(digestItems).where(eq(digestItems.digestId, digestId));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      // Any un-stripped field would have ABORTED the whole insert (Postgres text/jsonb reject U+0000);
      // asserting the stored values still pins each of the five strip call sites individually.
      expect(row.reason).toBe("whykept");
      expect(row.jobTitle).toBe("SrEng");
      expect(row.companySlug).toBe("acme");
      expect(row.applyUrl).toBe("https://x.test/a");
      expect(row.locations).toEqual(["Remote"]);
      expect(row.userId).toBe(a); // userId denormalized — the shown-history anti-join keys on it
      expect(row.remote).toBe(true);
      // Empty-list smoke: inserts nothing, throws nothing.
      await expect(insertDigestItems(db, digestId, a, [])).resolves.toBeUndefined();
      expect(await db.select().from(digestItems).where(eq(digestItems.digestId, digestId))).toHaveLength(1);
    });

    it("getJobSnapshots keys live jobs⋈companies display fields by id; missing ids absent; empty input → empty Map", async () => {
      const companyId = await seedCompany();
      const j1 = await seedJob(companyId, {
        title: "Platform Eng",
        applyUrl: "https://a",
        locations: ["NYC"],
        remote: false,
      });
      await seedJob(companyId); // J2 — leaking into the map = the inArray(jobs.id, jobIds) filter dropped
      const map = await getJobSnapshots(db, [j1, 424242]);
      expect(map.size).toBe(1);
      // A missing companySlug here = the companies INNER JOIN broke.
      expect(map.get(j1)).toEqual({
        jobTitle: "Platform Eng",
        companySlug: "acme",
        applyUrl: "https://a",
        locations: ["NYC"],
        remote: false,
      });
      expect(map.get(424242)).toBeUndefined();
      expect((await getJobSnapshots(db, [])).size).toBe(0);
    });

    it("getLatestDigestForUser orders by created_at DESC then id DESC, items by rank; null when the user has none", async () => {
      const a = await seedRecipient(1);
      const b = await seedRecipient(2);
      const companyId = await seedCompany();
      const j1 = await seedJob(companyId);
      const j2 = await seedJob(companyId);
      const d1 = (await seedDigestForUser(a, { itemCount: 0 })).digestId;
      const d2 = (await seedDigestForUser(a, { itemCount: 2, counts: { kept: 2 } })).digestId;
      const d3 = (await seedDigestForUser(a, { itemCount: 0 })).digestId;
      // Explicit created_at sentinels — relying on defaultNow() would make every ordering assertion
      // vacuous (all rows get near-identical stamps). d1 (LOWEST id) gets the NEWEST date so id order
      // OPPOSES created_at order; d2/d3 tie so id DESC has its own witness.
      await db.update(digests).set({ createdAt: new Date("2026-03-01T00:00:00Z") }).where(eq(digests.id, d1));
      await db.update(digests).set({ createdAt: new Date("2026-02-01T00:00:00Z") }).where(eq(digests.id, d2));
      await db.update(digests).set({ createdAt: new Date("2026-02-01T00:00:00Z") }).where(eq(digests.id, d3));
      // d2's items inserted OUT of rank order (2 then 1) so the items orderBy(rank) is load-bearing.
      await insertDigestItems(db, d2, a, [item(j2, 2, { score: 0.25 }), item(j1, 1)]);

      // Newest created_at wins despite the LOWEST id — removing desc(createdAt) would surface d3.
      expect((await getLatestDigestForUser(db, a))?.id).toBe(d1);

      await db.delete(digests).where(eq(digests.id, d1));
      // d2/d3 tie on created_at — id DESC breaks it; removing desc(digests.id) flips this to d2.
      expect((await getLatestDigestForUser(db, a))?.id).toBe(d3);

      await db.delete(digests).where(eq(digests.id, d3));
      const view = await getLatestDigestForUser(db, a);
      expect(view).not.toBeNull();
      expect(view!.id).toBe(d2);
      expect(view!.itemCount).toBe(2);
      expect(view!.counts).toEqual({ kept: 2 });
      // Ranks ascend even though rank 2 was inserted first — the items orderBy(rank) proof.
      expect(view!.items.map((i) => i.rank)).toEqual([1, 2]);
      expect(view!.items.map((i) => i.jobId)).toEqual([j1, j2]);

      expect(await getLatestDigestForUser(db, b)).toBeNull();
    });

    it("getDigestApplyTargets reads the LIVE jobs.apply_url — never the frozen snapshot — for one digest, by rank", async () => {
      const a = await seedRecipient(1);
      const companyId = await seedCompany();
      const j1 = await seedJob(companyId, { applyUrl: "https://live/J1" });
      const j2 = await seedJob(companyId, { applyUrl: "https://live/J2" });
      const j3 = await seedJob(companyId, { applyUrl: "https://live/J3" });
      const dA = (await seedDigestForUser(a, { itemCount: 2 })).digestId;
      // Snapshot urls DIVERGE from live on purpose, and rank 2 is inserted FIRST: reading
      // digestItems.applyUrl (breaking the 410-close-on-current-url design) or dropping orderBy(rank)
      // each flip a different assertion below.
      await insertDigestItems(db, dA, a, [
        item(j2, 2, { applyUrl: "https://snap/J2" }),
        item(j1, 1, { applyUrl: "https://snap/J1" }),
      ]);
      const dB = (await seedDigestForUser(a, { itemCount: 1 })).digestId;
      await insertDigestItems(db, dB, a, [item(j3, 1, { applyUrl: "https://snap/J3" })]);

      // j3 appearing = the eq(digestItems.digestId) where was dropped.
      expect(await getDigestApplyTargets(db, dA)).toEqual([
        { jobId: j1, applyUrl: "https://live/J1" },
        { jobId: j2, applyUrl: "https://live/J2" },
      ]);
    });

    it("dropDigestItemsAndRecount deletes only this digest's listed job_ids, lands the passed survivor count, and jsonb-merges counts", async () => {
      const a = await seedRecipient(1);
      const companyId = await seedCompany();
      const j1 = await seedJob(companyId);
      const j2 = await seedJob(companyId);
      const j3 = await seedJob(companyId);
      const dA = (await seedDigestForUser(a, { itemCount: 3, counts: { retrieved: 5 } })).digestId;
      await insertDigestItems(db, dA, a, [item(j1, 1), item(j2, 2), item(j3, 3)]);
      // dB holds the SAME job id in a DIFFERENT digest — the tripwire for the CTE's digest_id scope.
      const dB = (await seedDigestForUser(a, { itemCount: 1 })).digestId;
      await insertDigestItems(db, dB, a, [item(j2, 1)]);

      await dropDigestItemsAndRecount(db, dA, [j2], 2, { probedOk: 2, probed404Dropped: 1 });

      const dARows = await db.select().from(digestItems).where(eq(digestItems.digestId, dA));
      expect(dARows.map((r) => r.jobId).sort((x, y) => x - y)).toEqual([j1, j3]);
      // dB's job-2 item surviving = the `digest_id = ${digestId}` half of the CTE WHERE held.
      expect(await db.select().from(digestItems).where(eq(digestItems.digestId, dB))).toHaveLength(1);
      const header = await readDigest(dA);
      expect(header.itemCount).toBe(2);
      // retrieved:5 preserved = the `counts || $::jsonb` MERGE (a plain assignment would lose it).
      expect(header.counts).toEqual({ retrieved: 5, probedOk: 2, probed404Dropped: 1 });
      // dB's HEADER untouched: the UPDATE half of the statement has its OWN `WHERE id = digestId` —
      // without it every probe-drop write would clobber item_count and counts on EVERY digests row.
      const headerB = await readDigest(dB);
      expect(headerB.itemCount).toBe(1);
      expect(headerB.counts).toEqual({});
    });

    it("dropDigestItemsAndRecount with empty droppedJobIds deletes nothing and still lands the PASSED survivor count + counts", async () => {
      const a = await seedRecipient(1);
      const companyId = await seedCompany();
      const j1 = await seedJob(companyId);
      const j2 = await seedJob(companyId);
      const dC = (await seedDigestForUser(a, { itemCount: 2, counts: { retrieved: 9 } })).digestId;
      await insertDigestItems(db, dC, a, [item(j1, 1), item(j2, 2)]);

      // survivorCount 7 is DELIBERATELY ≠ the live count (2): the CTE's delete is invisible to a
      // same-statement count(*), so item_count must be the caller-passed value — a "fix" that
      // recomputes it in-statement flips this to 2.
      await dropDigestItemsAndRecount(db, dC, [], 7, { probedOk: 7 });

      // Empty int[] (`{}`::int[]) must delete nothing.
      expect(await db.select().from(digestItems).where(eq(digestItems.digestId, dC))).toHaveLength(2);
      const header = await readDigest(dC);
      expect(header.itemCount).toBe(7);
      expect(header.counts).toEqual({ retrieved: 9, probedOk: 7 });
    });
  });

  describe("getDigestEmailPayload — the one-round-trip render read", () => {
    it("resolves the recipient from the user ROW with the digest's createdAt — exact values, not just non-empty", async () => {
      const a = await seedRecipient(1, { name: "Jo Test", email: "jo@test.local" });
      const companyId = await seedCompany();
      const j1 = await seedJob(companyId);
      const { digestId } = await seedDigestForUser(a, { itemCount: 1 });
      const createdAt = new Date("2026-05-01T12:00:00Z");
      await db.update(digests).set({ createdAt }).where(eq(digests.id, digestId));
      await insertDigestItems(db, digestId, a, [item(j1, 1)]);

      const payload = await getDigestEmailPayload(db, digestId);
      expect(payload).not.toBeNull();
      // Exact values (not the script's length>0 checks) also catch a swapped email/name projection.
      expect(payload!.recipient).toEqual({ email: "jo@test.local", name: "Jo Test" });
      expect(payload!.createdAt).toBeInstanceOf(Date);
      expect(payload!.createdAt.getTime()).toBe(createdAt.getTime());
      expect(payload!.userId).toBe(a);
      expect(payload!.digestId).toBe(digestId);
    });

    it("returns items ordered by rank regardless of insertion order", async () => {
      const a = await seedRecipient(1);
      const companyId = await seedCompany();
      const j1 = await seedJob(companyId);
      const j2 = await seedJob(companyId);
      const j3 = await seedJob(companyId);
      const { digestId } = await seedDigestForUser(a, { itemCount: 3 });
      // Insertion order (3, 1, 2) deliberately disagrees with rank order — a default-order fluke
      // cannot pass; removing orderBy(digestItems.rank) yields [3, 1, 2].
      await insertDigestItems(db, digestId, a, [item(j3, 3), item(j1, 1), item(j2, 2)]);

      const payload = await getDigestEmailPayload(db, digestId);
      expect(payload).not.toBeNull();
      expect(payload!.items.map((i) => i.rank)).toEqual([1, 2, 3]);
    });

    it("filters non-active live jobs APP-side — a closed item drops; all-closed returns a NON-null empty-items payload", async () => {
      const a = await seedRecipient(1);
      const companyId = await seedCompany();
      const jActive = await seedJob(companyId);
      // JB differs from JA ONLY on lifecycle_state (both snapshots fully populated), so only the
      // `.filter(r => r.lifecycleState === "active")` can drop it — not a missing snapshot.
      const jClosed = await seedJob(companyId, { lifecycleState: "closed" });
      const { digestId } = await seedDigestForUser(a, { itemCount: 2 });
      await insertDigestItems(db, digestId, a, [item(jActive, 1), item(jClosed, 2)]);

      const phase1 = await getDigestEmailPayload(db, digestId);
      expect(phase1).not.toBeNull();
      expect(phase1!.items).toHaveLength(1);
      expect(phase1!.items[0]!.rank).toBe(1); // the survivor is JA's item, and items.length < itemCount (2)

      // Phase 2: close the last active job — the clean no-send shape must stay NON-null with items [],
      // never regress into the null invariant-break shape.
      await db.update(jobs).set({ lifecycleState: "closed" }).where(eq(jobs.id, jActive));
      const phase2 = await getDigestEmailPayload(db, digestId);
      expect(phase2).not.toBeNull();
      expect(phase2!.items).toEqual([]);
      expect(phase2!.recipient.email).toBe("user1@test.local"); // header still populated from any row
      expect(phase2!.createdAt).toBeInstanceOf(Date);
    });

    it("returns null for zero digest_items rows AND for an unknown digest id — never an empty-items object", async () => {
      const a = await seedRecipient(1);
      const { digestId } = await seedDigestForUser(a, { itemCount: 0 }); // header with NO items
      // A non-null here = the digestItems INNER JOIN weakened to LEFT, blurring the invariant-break
      // signal (null) into the clean no-send shape ({ items: [] }) the caller branches on.
      expect(await getDigestEmailPayload(db, digestId)).toBeNull();
      expect(await getDigestEmailPayload(db, 999999)).toBeNull();
    });

    it("snapshot wins over divergent live fields, NULL snapshot falls back to live, and a pruned job's item filters out while the header survives", async () => {
      const a = await seedRecipient(1);
      const companyId = await seedCompany(); // slug 'acme' — the live companySlug fallback for I2
      const jDivergent = await seedJob(companyId, {
        title: "Live Title",
        applyUrl: "https://live",
        locations: ["Liveville"],
        remote: false,
      });
      const jLiveOnly = await seedJob(companyId, {
        title: "Live Only",
        applyUrl: "https://live/only",
        locations: ["Fallbackton"],
        remote: false,
      });
      const jPruned = await seedJob(companyId);
      const { digestId } = await seedDigestForUser(a, { itemCount: 3 });
      // I1: full snapshot DIVERGING from the live row on every field.
      await insertDigestItems(db, digestId, a, [
        item(jDivergent, 1, {
          reason: "r1",
          jobTitle: "Snap Title",
          companySlug: "snap-co",
          applyUrl: "https://snap",
          locations: ["Snapville"],
          remote: true,
        }),
      ]);
      // I2: un-backfilled row — snapshot columns all NULL (insertDigestItems can't write NULLs, so
      // seed directly), forcing the COALESCE onto its live jobs/companies leg.
      await db.insert(digestItems).values({
        digestId,
        userId: a,
        jobId: jLiveOnly,
        rank: 2,
        score: 0.25,
        reason: "r2",
      });
      // I3: snapshot populated, then the jobs row HARD-DELETED (legal — job_id has no FK): the prune case.
      await insertDigestItems(db, digestId, a, [item(jPruned, 3)]);
      await db.delete(jobs).where(eq(jobs.id, jPruned));

      const payload = await getDigestEmailPayload(db, digestId);
      expect(payload).not.toBeNull();
      // I3 absent: a pruned job's LEFT-miss yields NULL lifecycle_state → filtered (never email a pruned role).
      expect(payload!.items).toHaveLength(2);
      // I1: every field is the FROZEN snapshot — a swapped COALESCE argument order would render the live values.
      expect(payload!.items[0]!).toEqual({
        rank: 1,
        reason: "r1",
        title: "Snap Title",
        companySlug: "snap-co",
        applyUrl: "https://snap",
        locations: ["Snapville"],
        remote: true,
      });
      // I2: NULL snapshot falls back to the live jobs/companies row — dropping the fallback leg NULLs these.
      expect(payload!.items[1]!).toEqual({
        rank: 2,
        reason: "r2",
        title: "Live Only",
        companySlug: "acme",
        applyUrl: "https://live/only",
        locations: ["Fallbackton"],
        remote: false,
      });

      // Single-item variant: the ONLY item's job pruned — a LEFT-join regression to INNER empties the
      // rowset and returns null instead of the non-null empty-items header.
      const solo = await seedDigestForUser(a, { itemCount: 1 });
      const jSolo = await seedJob(companyId);
      await insertDigestItems(db, solo.digestId, a, [item(jSolo, 1)]);
      await db.delete(jobs).where(eq(jobs.id, jSolo));
      const soloPayload = await getDigestEmailPayload(db, solo.digestId);
      expect(soloPayload).not.toBeNull();
      expect(soloPayload!.items).toEqual([]);
      expect(soloPayload!.recipient.email).toBe("user1@test.local");
    });

    it("surfaces the send permit as approvedAt — a Date when granted, null when not, never on items", async () => {
      const approvedAt = new Date("2026-04-01T00:00:00Z");
      const p = await seedRecipient(1, { digestApprovedAt: approvedAt });
      // Q can still HAVE a digest — the permit gate is enforced by the caller, not the read.
      const q = await seedRecipient(2, { digestApprovedAt: null });
      const companyId = await seedCompany();
      const j1 = await seedJob(companyId);
      const dP = (await seedDigestForUser(p, { itemCount: 1 })).digestId;
      await insertDigestItems(db, dP, p, [item(j1, 1)]);
      const dQ = (await seedDigestForUser(q, { itemCount: 1 })).digestId;
      await insertDigestItems(db, dQ, q, [item(j1, 1)]);

      const payloadP = await getDigestEmailPayload(db, dP);
      expect(payloadP).not.toBeNull();
      expect(payloadP!.approvedAt).toBeInstanceOf(Date);
      expect(payloadP!.approvedAt!.getTime()).toBe(approvedAt.getTime());
      const payloadQ = await getDigestEmailPayload(db, dQ);
      expect(payloadQ).not.toBeNull();
      // A Date here = a fail-OPEN default (e.g. COALESCE(..., now())) crept into the permit read.
      expect(payloadQ!.approvedAt).toBeNull();
      // GATE-ONLY boundary: the permit never enters the rendered item bytes (Resend idempotency contract).
      expect(payloadP!.items).toHaveLength(1);
      expect(payloadP!.items[0]!).not.toHaveProperty("approvedAt");
    });

    it("projects every render field per item exactly as persisted", async () => {
      const a = await seedRecipient(1);
      const companyId = await seedCompany();
      const j1 = await seedJob(companyId);
      const { digestId } = await seedDigestForUser(a, { itemCount: 1 });
      await insertDigestItems(db, digestId, a, [
        item(j1, 1, {
          reason: "strong match",
          jobTitle: "Sr Eng",
          companySlug: "acme-co",
          applyUrl: "https://apply.test/1",
          locations: ["NYC", "Remote"],
          remote: true,
        }),
      ]);
      const payload = await getDigestEmailPayload(db, digestId);
      expect(payload).not.toBeNull();
      expect(payload!.items).toHaveLength(1);
      // One deep-equal subsumes all six of the retired script's per-item shape checks — any dropped
      // selection or projection rename mismatches it.
      expect(payload!.items[0]!).toEqual({
        rank: 1,
        reason: "strong match",
        title: "Sr Eng",
        companySlug: "acme-co",
        applyUrl: "https://apply.test/1",
        locations: ["NYC", "Remote"],
        remote: true,
      });
    });
  });

  describe("delivery-state writes — sent / considered / outcome / failure", () => {
    it("recordDigestSent stamps the digest then ONLY the owner's prefs; an unknown digest id throws", async () => {
      const a = await seedRecipient(1);
      const b = await seedRecipient(2);
      const dA = (await seedDigestForUser(a)).digestId;
      await seedDigestForUser(b);

      await recordDigestSent(db, dA, "resend-email-1");

      const digest = await readDigest(dA);
      expect(digest.emailId).toBe("resend-email-1");
      expect(digest.deliveryStatus).toBe("sent");
      // sent_at is DB-side now() — assert recency with a generous margin, never equality with JS time.
      expect(digest.sentAt).toBeInstanceOf(Date);
      expect(digest.sentAt!.getTime()).toBeGreaterThan(Date.now() - 3_600_000);
      const prefsA = await readPrefs(a);
      expect(prefsA.lastDigestEmailId).toBe("resend-email-1");
      expect(prefsA.lastDigestSentAt).toBeInstanceOf(Date);
      // B is the tripwire: B's prefs stamped too = the second update lost its userId WHERE (or the
      // returning-userId plumbing broke) and every user's cadence clock would move on any send.
      const prefsB = await readPrefs(b);
      expect(prefsB.lastDigestEmailId).toBeNull();
      expect(prefsB.lastDigestSentAt).toBeNull();

      await expect(recordDigestSent(db, 999999, "x")).rejects.toThrow(/matched no digest/);
    });

    it("markDigestConsidered stamps last_digest_sent_at and NULLs the email id — backing the user off the cadence window", async () => {
      const a = await seedRecipient(1, {
        digestCadence: "daily",
        lastDigestSentAt: hoursAgo(25),
        lastDigestEmailId: "prev-real-email", // a prior REAL send — the mislabel tripwire
      });
      // Never-sent bystander: an UNSCOPED considered-stamp (missing its userId WHERE) would back
      // EVERY user off their window each tick — the daily cron would perpetually re-stamp everyone
      // and digests would silently stop for all users.
      const b = await seedRecipient(2, { digestCadence: "daily" });
      // Pre-check: the 25h-stale user AND the never-sent bystander are both cadence-due.
      expect(await listDigestRecipients(db, { limit: 10, cadenceDue: true })).toEqual([
        { userId: a },
        { userId: b },
      ]);

      await markDigestConsidered(db, a);

      const prefs = await readPrefs(a);
      // A surviving 'prev-real-email' = the lastDigestEmailId:null set member was dropped, mislabeling
      // a considered-only tick as a delivered send.
      expect(prefs.lastDigestEmailId).toBeNull();
      expect(prefs.lastDigestSentAt).toBeInstanceOf(Date);
      expect(prefs.lastDigestSentAt!.getTime()).toBeGreaterThan(Date.now() - 3_600_000);
      // Bystander untouched: B keeps its NULL stamps...
      const prefsB = await readPrefs(b);
      expect(prefsB.lastDigestSentAt).toBeNull();
      expect(prefsB.lastDigestEmailId).toBeNull();
      // ...and the stamp feeds cadenceDuePredicate — A is off the window, B is still due.
      expect(await listDigestRecipients(db, { limit: 10, cadenceDue: true })).toEqual([{ userId: b }]);
    });

    it("recordDigestDeliveryOutcome without suppress upgrades ONLY delivery_status; an unknown id throws", async () => {
      const a = await seedRecipient(1);
      const dA = (await seedDigestForUser(a)).digestId;
      await recordDigestSent(db, dA, "resend-email-1");

      await recordDigestDeliveryOutcome(db, dA, { status: "delivered" });

      expect((await readDigest(dA)).deliveryStatus).toBe("delivered");
      const prefs = await readPrefs(a);
      // Suppression stamped on a plain 'delivered' poll = the `if (!outcome.suppress) return` early
      // exit was dropped — that would silently unsubscribe every successfully-delivered user.
      expect(prefs.digestSuppressedAt).toBeNull();
      expect(prefs.digestBounceStatus).toBe("none");

      await expect(recordDigestDeliveryOutcome(db, 999999, { status: "delivered" })).rejects.toThrow(
        /matched no digest/,
      );
    });

    it("suppressing outcomes COALESCE-keep an existing suppression timestamp and touch bounce status only when given", async () => {
      // (a) bounce path: fresh suppression + hard bounce recorded together.
      const a = await seedRecipient(1);
      const dA = (await seedDigestForUser(a)).digestId;
      await recordDigestDeliveryOutcome(db, dA, { status: "bounced", suppress: { bounce: "hard" } });
      let prefsA = await readPrefs(a);
      expect(prefsA.digestSuppressedAt).toBeInstanceOf(Date);
      expect(prefsA.digestBounceStatus).toBe("hard");
      expect((await readDigest(dA)).deliveryStatus).toBe("bounced");

      // (b) COALESCE path: plant an EXPLICIT past sentinel (never compare two near-identical now()
      // stamps — flaky), then re-run the suppressing record step.
      const planted = new Date("2026-01-01T00:00:00Z");
      await db
        .update(userPreferences)
        .set({ digestSuppressedAt: planted })
        .where(eq(userPreferences.userId, a));
      await recordDigestDeliveryOutcome(db, dA, { status: "bounced", suppress: { bounce: "hard" } });
      prefsA = await readPrefs(a);
      // A moved timestamp = COALESCE(existing, now()) replaced by a plain now() assignment — a retried
      // record step would rewrite suppression history.
      expect(prefsA.digestSuppressedAt!.getTime()).toBe(planted.getTime());

      // (c) complaint path: suppress WITHOUT a bounce value — a previously recorded hard bounce must survive.
      const b = await seedRecipient(2, { digestBounceStatus: "hard" });
      const dB = (await seedDigestForUser(b)).digestId;
      // (d) clean bystander, seeded BEFORE the (c) write: an UNSCOPED suppression update (missing
      // its userId WHERE) would stamp digest_suppressed_at table-wide — the whole recipient base
      // silently unsubscribed. A alone can't witness this (its sentinel is COALESCE-kept anyway).
      const c = await seedRecipient(3);
      await recordDigestDeliveryOutcome(db, dB, { status: "delivered", suppress: {} });
      const prefsB = await readPrefs(b);
      expect(prefsB.digestSuppressedAt).toBeInstanceOf(Date);
      // 'hard' reset here = the conditional spread became an unconditional bounce write (e.g. a 'none'
      // default) — erasing the hard-bounce record is the exact regression the optional field prevents.
      expect(prefsB.digestBounceStatus).toBe("hard");
      expect((await readDigest(dB)).deliveryStatus).toBe("delivered");
      // The bystander is untouched — suppression landed on B ONLY.
      const prefsC = await readPrefs(c);
      expect(prefsC.digestSuppressedAt).toBeNull();
      expect(prefsC.digestBounceStatus).toBe("none");
    });

    it("recordDigestSendFailure marks failed with send fields left NULL and never throws for a missing digest", async () => {
      const a = await seedRecipient(1);
      const dA = (await seedDigestForUser(a)).digestId;
      // Bystander digest: an UNSCOPED failure write (missing its digest-id WHERE) would flip
      // delivery_status='failed' on EVERY row, corrupting the whole delivery history.
      const b = await seedRecipient(2);
      const dB = (await seedDigestForUser(b)).digestId;

      await recordDigestSendFailure(db, dA);

      const digest = await readDigest(dA);
      expect(digest.deliveryStatus).toBe("failed");
      // email_id/sent_at staying NULL = the failure write never fabricates send evidence.
      expect(digest.emailId).toBeNull();
      expect(digest.sentAt).toBeNull();
      // The bystander keeps its pristine delivery state.
      const digestB = await readDigest(dB);
      expect(digestB.deliveryStatus).toBe("none");
      expect(digestB.emailId).toBeNull();
      expect(digestB.sentAt).toBeNull();
      // Failure-path posture: resolving (not throwing) on a missing row — a second error here would
      // mask the ORIGINAL send error; "fixing" this to the throwing posture of its siblings reds this.
      await expect(recordDigestSendFailure(db, 999999)).resolves.toBeUndefined();
    });
  });
});
