import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  getProfileForDigest,
  insertCvFile,
  markCvFileFailed,
  patchCvFileExtracted,
} from "@opusfinder/db/repos";
import { user, userCvFiles, userProfiles } from "@opusfinder/db/schema";
import type { UserId } from "@opusfinder/shared";

import { uid } from "@test/db/ids";
import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";
import { oneHot } from "@test/db/vectors";

// What this file proves: the profiles repo behaviors the ingest/restructure pipelines CANNOT observe.
// (1) The userId ownership half of the `(id AND user_id)` UPDATE predicates in markCvFileFailed and
// patchCvFileExtracted: ingestCv only ever passes a row's OWN (fileId, userId) pair, and id is a
// unique serial — so through the pipeline `eq(id)` alone selects the identical row set and dropping
// the userId half is invisible to every bystander. The ONLY killing observation is a direct call with
// a MISMATCHED pair (B's row id + A's userId) asserting B's row is byte-identical after.
// (2) getProfileForDigest — owned by NO other suite repo-wide — including its emailVerified
// pass-through (the generation-time paid-spend gate's raw material; the READ projects the flag, the
// caller gates on it) and the null-embedding arm the digest caller skips.
// NOT constructible here: the inner-join missing-user arm — user_profiles.user_id is a NOT NULL FK
// onto user.id, so a profile row without a user row cannot exist; the join's observable job is the
// emailVerified projection, pinned below in both polarities.

describe("profiles repo — UPDATE ownership predicates + getProfileForDigest (integration: real PGlite semantics)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    await truncate(db, userProfiles, userCvFiles, user);
  });
  afterAll(async () => {
    // Optional-chained: if beforeAll's createTestDb() rejected, a bare close() would bury the real
    // failure under a secondary TypeError. Drains the WASM handle → clean Windows teardown.
    await close?.();
  });

  async function seedUser(n: number, opts: { emailVerified?: boolean } = {}): Promise<UserId> {
    const userId = uid(n);
    await db.insert(user).values({
      id: userId,
      name: `User ${n}`,
      email: `user${n}@test.local`,
      emailVerified: opts.emailVerified ?? true,
    });
    return userId;
  }

  /** One upload row. Status defaults to 'failed' (the provisional value) with r2_text_key and
   *  error_sample NULL — the state where BOTH update paths would land if their WHERE let them. */
  async function seedCvFile(userId: UserId, n: number): Promise<number> {
    const rows = await db
      .insert(userCvFiles)
      .values({
        userId,
        r2OriginalKey: `originals/${userId}/${n}.pdf`,
        filename: `cv-${n}.pdf`,
        contentType: "application/pdf",
        byteSize: 2048,
      })
      .returning({ id: userCvFiles.id });
    const row = rows[0];
    if (!row) throw new Error("seedCvFile returned no row");
    return row.id;
  }

  async function readCvRow(id: number) {
    const rows = await db.select().from(userCvFiles).where(eq(userCvFiles.id, id));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  describe("markCvFileFailed / patchCvFileExtracted — the userId half of the ownership WHERE", () => {
    it("markCvFileFailed with a MISMATCHED pair (B's row id + A's userId) matches 0 rows — B's row is byte-identical", async () => {
      const a = await seedUser(1);
      const b = await seedUser(2);
      // A's own row is the id-half bystander: a WHERE degraded to userId-only would mark IT instead.
      const aRowId = await seedCvFile(a, 1);
      const bRowId = await seedCvFile(b, 2);
      // B's row is 'failed' (non-extracted), so the ne(status,'extracted') guard passes — the userId
      // predicate is the ONLY clause that can block this write.
      const aBefore = await readCvRow(aRowId);
      const bBefore = await readCvRow(bRowId);
      expect(bBefore.status).toBe("failed");
      expect(bBefore.errorSample).toBeNull();

      // Resolves silently (an UPDATE matching 0 rows is not an error) — and writes NOTHING.
      await markCvFileFailed(db, bRowId, a, "cross-user mark attempt");

      // errorSample landing on B = the userId half was dropped (eq(id) alone selects B's row).
      expect(await readCvRow(bRowId)).toEqual(bBefore);
      // errorSample landing on A = the id half was dropped (userId + ne alone selects A's row).
      expect(await readCvRow(aRowId)).toEqual(aBefore);
    });

    it("patchCvFileExtracted with a MISMATCHED pair matches 0 rows — B's row never flips to 'extracted'", async () => {
      const a = await seedUser(1);
      const b = await seedUser(2);
      const aRowId = await seedCvFile(a, 1);
      const bRowId = await seedCvFile(b, 2);
      const aBefore = await readCvRow(aRowId);
      const bBefore = await readCvRow(bRowId);

      await patchCvFileExtracted(db, bRowId, a, "text/evil.txt");

      // A landed write would be LOUD here: status 'extracted' + the foreign r2_text_key on B's row
      // (userId half dropped) or on A's row (id half dropped). Both must be byte-identical.
      const bAfter = await readCvRow(bRowId);
      expect(bAfter.status).toBe("failed");
      expect(bAfter.r2TextKey).toBeNull();
      expect(bAfter).toEqual(bBefore);
      expect(await readCvRow(aRowId)).toEqual(aBefore);
    });
  });

  describe("insertCvFile — hostile-metadata NUL strips the pipeline cannot reach", () => {
    it("strips a NUL byte from r2OriginalKey and contentType (filename's strip is pipeline-covered)", async () => {
      const a = await seedUser(1);
      // ingestCv mints r2OriginalKey from originalKey(userId, uuid) — NUL-free by construction — so
      // only a direct call can witness these two strips. Runtime-built NUL, never a literal escape.
      const NUL = String.fromCharCode(0);
      const { id } = await insertCvFile(db, {
        userId: a,
        r2OriginalKey: `originals/${a}/host${NUL}ile.pdf`,
        filename: `cv${NUL}file.pdf`,
        contentType: `application/x-opus${NUL}finder-test`,
        byteSize: 1024,
      });

      const row = await readCvRow(id);
      expect(row.r2OriginalKey).toBe(`originals/${a}/hostile.pdf`);
      expect(row.filename).toBe("cvfile.pdf");
      expect(row.contentType).toBe("application/x-opusfinder-test");
    });
  });

  describe("getProfileForDigest — the digest read no other suite owns", () => {
    async function seedProfile(
      userId: UserId,
      sourceCvFileId: number,
      opts: { summary?: string; embedding?: number[] | null } = {},
    ): Promise<void> {
      await db.insert(userProfiles).values({
        userId,
        structured: {
          summary: opts.summary ?? "backend engineer, 6 yoe",
          skills: ["typescript", "postgres"],
          targetRoles: ["Platform Engineer"],
        },
        embedding: opts.embedding === undefined ? oneHot(2) : opts.embedding,
        sourceCvFileId,
      });
    }

    it("returns null when the user has no profile row, and for a never-seeded userId", async () => {
      const a = await seedUser(1);
      await seedCvFile(a, 1); // an upload exists — the read keys on user_profiles, not user_cv_files
      expect(await getProfileForDigest(db, a)).toBeNull();
      expect(await getProfileForDigest(db, uid(99))).toBeNull();
    });

    it("returns the full profile with emailVerified TRUE passed through the user inner join", async () => {
      const a = await seedUser(1, { emailVerified: true });
      const cvId = await seedCvFile(a, 1);
      await seedProfile(a, cvId, { summary: "staff platform engineer" });

      // Exact-shape equality: any dropped projection, a swapped column, or a hardcoded flag mismatches.
      // oneHot components (0/1) are float4-exact, so the vector round-trips byte-identically.
      expect(await getProfileForDigest(db, a)).toEqual({
        structured: {
          summary: "staff platform engineer",
          skills: ["typescript", "postgres"],
          targetRoles: ["Platform Engineer"],
        },
        embedding: oneHot(2),
        sourceCvFileId: cvId,
        emailVerified: true,
      });
    });

    it("passes emailVerified FALSE through as false — the profile is still returned; the CALLER gates the paid spend", async () => {
      const a = await seedUser(1, { emailVerified: false });
      const cvId = await seedCvFile(a, 1);
      await seedProfile(a, cvId);

      const profile = await getProfileForDigest(db, a);
      // Non-null: the read does NOT filter unverified users — it surfaces the flag for the
      // generation-time gate. A hardcoded `emailVerified: true` (or a dropped join leg defaulting the
      // flag) is exactly what lets a manual trigger spend tokens on an unverified user.
      expect(profile).not.toBeNull();
      expect(profile!.emailVerified).toBe(false);
      expect(profile!.sourceCvFileId).toBe(cvId);
    });

    it("returns embedding NULL (not a null profile) for a row written with no embeddable content", async () => {
      const a = await seedUser(1);
      const cvId = await seedCvFile(a, 1);
      await seedProfile(a, cvId, { embedding: null });

      const profile = await getProfileForDigest(db, a);
      // The null-embedding arm is a NON-null profile with embedding === null — the digest caller
      // skips such users itself; collapsing this arm into the null return would be indistinguishable
      // from "no profile" and lose the distinction the caller logs on.
      expect(profile).not.toBeNull();
      expect(profile!.embedding).toBeNull();
      expect(profile!.structured.summary).toBe("backend engineer, 6 yoe");
      expect(profile!.emailVerified).toBe(true);
    });

    it("scopes to the requested user — A and B each get their OWN profile, never the other's", async () => {
      const a = await seedUser(1, { emailVerified: true });
      const b = await seedUser(2, { emailVerified: false });
      const aCvId = await seedCvFile(a, 1);
      const bCvId = await seedCvFile(b, 2);
      await seedProfile(a, aCvId, { summary: "profile A summary" });
      await seedProfile(b, bCvId, { summary: "profile B summary" });

      // A dropped eq(userProfiles.userId, userId) WHERE + limit(1) returns an ARBITRARY row: the
      // summary/emailVerified/sourceCvFileId triple differs per user, so either call would mismatch.
      const profileA = await getProfileForDigest(db, a);
      expect(profileA!.structured.summary).toBe("profile A summary");
      expect(profileA!.sourceCvFileId).toBe(aCvId);
      expect(profileA!.emailVerified).toBe(true);
      const profileB = await getProfileForDigest(db, b);
      expect(profileB!.structured.summary).toBe("profile B summary");
      expect(profileB!.sourceCvFileId).toBe(bCvId);
      expect(profileB!.emailVerified).toBe(false);
    });
  });
});
