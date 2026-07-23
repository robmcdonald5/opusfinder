import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@opusfinder/db";
import { user, userCvFiles, userProfiles, type CvFileStatus } from "@opusfinder/db/schema";
import type { StructuredProfile, UserId } from "@opusfinder/shared";
import type { StorageClient } from "@opusfinder/storage";

import { uid } from "@test/db/ids";
import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";
import { oneHot } from "@test/db/vectors";
import { rejectionOf } from "@test/rejection";

import { restructureProfile } from "./restructure";
import type { ProfileEmbedFn, StructureFn } from "./types";

// What this file proves: restructureProfile's whole cached-transcript re-run pipeline against real
// PGlite semantics — the getProfileTextKey lookup (latest-extracted-wins, newer-failed-never-shadows,
// NULL-r2_text_key-no-fallback, userId scoping), the storage read + UTF-8 decode, the pipeline-owned
// PII scrub BEFORE persist/embed, the three abort branches (no transcript / missing object /
// no embeddable content) plus the two embed-side aborts (empty seam response, vectorLiteral width
// throw) all landing BEFORE any user_profiles write, and the upsert INSERT/UPDATE arms with their
// user_id conflict-target scope. All failure branches here are plain JS Errors thrown before SQL
// executes, so exact-message matching is used throughout (no err.cause unwrapping needed).
// Net-new coverage — restructureProfile has no smoke script to retire.

// NUL is built at RUNTIME — a literal escape in this source would be decoded to a real byte by the
// file-writing tool and corrupt the file.
const NUL = String.fromCharCode(0);

/** A clean, PII-free structured profile: scrubProfilePii is the identity on it, so persisted
 *  `structured` can be asserted with strict equality. */
const CLEAN_PROFILE: StructuredProfile = {
  summary: "Backend engineer building high-throughput payment systems.",
  skills: ["Go", "PostgreSQL"],
  targetRoles: ["Senior Backend Engineer"],
};

function transcriptMap(entries: Record<string, string>): Map<string, Uint8Array> {
  const enc = new TextEncoder();
  return new Map(Object.entries(entries).map(([k, v]) => [k, enc.encode(v)]));
}

/** Map-backed getObject with a call recorder, plus never-called spies for the write/lifecycle
 *  surface — a lean fake, not a full StorageClient reimplementation. */
function fakeStorage(objects: Map<string, Uint8Array> = new Map()) {
  const getObjectKeys: string[] = [];
  const putObject = vi.fn<StorageClient["putObject"]>(async () => {});
  const deleteObject = vi.fn<StorageClient["deleteObject"]>(async () => {});
  const close = vi.fn<StorageClient["close"]>(() => {});
  const storage: StorageClient = {
    putObject,
    async getObject(key) {
      getObjectKeys.push(key);
      return objects.get(key) ?? null;
    },
    deleteObject,
    close,
  };
  return { storage, getObjectKeys, putObject, deleteObject, close };
}

function stubStructure(profile: StructuredProfile) {
  return vi.fn<StructureFn>(async () => profile);
}

/** EMBEDDING_DIMENSIONS-wide by construction (oneHot) — never a hardcoded width. */
function stubEmbed(vector: number[] = oneHot(0)) {
  return vi.fn<ProfileEmbedFn>(async (texts) => ({
    embeddings: texts.map(() => vector),
    usage: { totalTokens: 42 },
  }));
}

describe("restructureProfile — cached-transcript re-run seam: lookup, scrub, embed, upsert (integration: real PGlite semantics)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;
  let cvSeq = 0; // distinct r2_original_key/filename per seeded upload across the whole file

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

  async function seedUser(n: number): Promise<UserId> {
    const userId = uid(n);
    await db.insert(user).values({
      id: userId,
      name: `User ${n}`,
      email: `user${n}@test.local`, // unique per row (user_email_uq)
      emailVerified: true,
    });
    return userId;
  }

  async function seedCvFile(
    userId: UserId,
    opts: { status: CvFileStatus; r2TextKey: string | null },
  ): Promise<number> {
    cvSeq += 1;
    const rows = await db
      .insert(userCvFiles)
      .values({
        userId,
        r2OriginalKey: `cv/original/${cvSeq}.pdf`,
        filename: `cv-${cvSeq}.pdf`,
        contentType: "application/pdf",
        byteSize: 2048,
        status: opts.status,
        r2TextKey: opts.r2TextKey,
      })
      .returning({ id: userCvFiles.id });
    const row = rows[0];
    if (!row) throw new Error("seedCvFile returned no row");
    return row.id;
  }

  async function seedProfileRow(
    userId: UserId,
    sourceCvFileId: number,
    structured: StructuredProfile,
    embedding: number[],
  ): Promise<void> {
    await db.insert(userProfiles).values({ userId, structured, embedding, sourceCvFileId });
  }

  function readProfiles(userId: UserId) {
    return db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .orderBy(userProfiles.id);
  }

  function readCvFiles(userId: UserId) {
    return db
      .select()
      .from(userCvFiles)
      .where(eq(userCvFiles.userId, userId))
      .orderBy(userCvFiles.id);
  }

  it("throws the exact no-cached-transcript message when the user has only failed uploads — nothing written", async () => {
    const a = await seedUser(1);
    await seedCvFile(a, { status: "failed", r2TextKey: null });
    const { storage, getObjectKeys } = fakeStorage();
    const structure = stubStructure(CLEAN_PROFILE);
    const embed = stubEmbed();

    const err = await rejectionOf(restructureProfile(db, { structure, embed, storage }, a));
    expect(err.message).toBe(`restructureProfile: no cached transcript for user ${a}`);

    // The throw is the FIRST statement's — nothing downstream ran, nothing was written.
    expect(getObjectKeys).toEqual([]);
    expect(structure).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(await readProfiles(a)).toHaveLength(0);
  });

  it("throws no-cached-transcript when the latest extracted row has a NULL r2_text_key — no fallback to an older extracted row", async () => {
    const a = await seedUser(1);
    const oldKey = "cv/text/a-old.txt";
    await seedCvFile(a, { status: "extracted", r2TextKey: oldKey });
    await seedCvFile(a, { status: "extracted", r2TextKey: null }); // LATEST extracted, key never patched
    // The older key HAS a readable transcript — so a fallback-to-older mutation would SUCCEED here
    // instead of throwing, turning this red.
    const { storage, getObjectKeys } = fakeStorage(transcriptMap({ [oldKey]: "old transcript" }));

    const err = await rejectionOf(
      restructureProfile(db, { structure: stubStructure(CLEAN_PROFILE), embed: stubEmbed(), storage }, a),
    );
    expect(err.message).toBe(`restructureProfile: no cached transcript for user ${a}`);
    expect(getObjectKeys).toEqual([]);
    expect(await readProfiles(a)).toHaveLength(0);
  });

  it("picks the LATEST extracted upload over an older one and is not shadowed by a newer failed row — getObject key and sourceCvFileId both pin it", async () => {
    const a = await seedUser(1);
    await seedCvFile(a, { status: "extracted", r2TextKey: "cv/text/1.txt" });
    const cv2 = await seedCvFile(a, { status: "extracted", r2TextKey: "cv/text/2.txt" });
    // NEWEST row is failed but STILL CARRIES a text key (e.g. a late failure after caching) — if the
    // status filter dropped out of getProfileTextKey, ORDER BY id DESC would pick this one.
    await seedCvFile(a, { status: "failed", r2TextKey: "cv/text/3.txt" });
    // All three keys are readable, so a wrong pick SUCCEEDS with the wrong key instead of erroring —
    // the assertions below (not a throw) are what catch it.
    const { storage, getObjectKeys } = fakeStorage(
      transcriptMap({
        "cv/text/1.txt": "old transcript",
        "cv/text/2.txt": "new transcript",
        "cv/text/3.txt": "failed transcript",
      }),
    );
    const structure = stubStructure(CLEAN_PROFILE);

    await restructureProfile(db, { structure, embed: stubEmbed(), storage }, a);

    expect(getObjectKeys).toEqual(["cv/text/2.txt"]);
    expect(structure).toHaveBeenCalledExactlyOnceWith("new transcript");
    const rows = await readProfiles(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceCvFileId).toBe(cv2);
  });

  it("throws transcript-object-missing carrying the exact R2 key when getObject returns null — no profile row appears", async () => {
    const a = await seedUser(1);
    await seedCvFile(a, { status: "extracted", r2TextKey: "cv/text/missing.txt" });
    const { storage } = fakeStorage(); // empty store → getObject returns null (never throws)
    const structure = stubStructure(CLEAN_PROFILE);
    const embed = stubEmbed();

    const err = await rejectionOf(restructureProfile(db, { structure, embed, storage }, a));
    expect(err.message).toBe("restructureProfile: transcript object missing at cv/text/missing.txt");
    expect(structure).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(await readProfiles(a)).toHaveLength(0);
  });

  it("decodes the stored transcript as UTF-8 and passes the exact decoded text (non-ASCII survives) to the structure seam", async () => {
    const a = await seedUser(1);
    await seedCvFile(a, { status: "extracted", r2TextKey: "cv/text/a.txt" });
    // Multibyte UTF-8 (é is 2 bytes, — is 3) — a latin-1/ascii decode would mangle these.
    const transcript = "Ingénieur logiciel — résumé naïve, São Paulo";
    const { storage } = fakeStorage(transcriptMap({ "cv/text/a.txt": transcript }));
    const structure = stubStructure(CLEAN_PROFILE);

    await restructureProfile(db, { structure, embed: stubEmbed(), storage }, a);

    expect(structure).toHaveBeenCalledExactlyOnceWith(transcript);
  });

  it("scrubs PII from the raw structure() output before persisting — email and 10-digit phone land [redacted], scrubbed-empty skills filtered; NUL in summary is stripped at write", async () => {
    const a = await seedUser(1);
    const cvId = await seedCvFile(a, { status: "extracted", r2TextKey: "cv/text/a.txt" });
    const { storage } = fakeStorage(transcriptMap({ "cv/text/a.txt": "transcript body" }));
    // RAW extraction output: the seam does NOT scrub (types.ts contract) — the pipeline must.
    const structure = stubStructure({
      summary: `Contact jane.doe@example.com or (682) 333-9323 for Sr${NUL}Eng work.`,
      skills: ["   ", "Go"], // whitespace-only entry scrubs to empty → filtered out
      targetRoles: ["Staff Engineer"],
    });
    const embed = stubEmbed();

    await restructureProfile(db, { structure, embed, storage }, a);

    // Scrub PRECEDES embed, and the composed query text is pinned EXACTLY — hand-written (never
    // computed via composeProfileText) so a composition regression can't rewrite the expectation
    // with the behavior: summary AND skills AND target roles all participate, the NUL is still
    // present pre-persist (stripNul runs only at the jsonb write), inputType stays "query", and the
    // seam was hit exactly ONCE — a duplicated embed call would silently double Voyage spend.
    expect(embed).toHaveBeenCalledExactlyOnceWith(
      [
        `Contact [redacted] or [redacted] for Sr${NUL}Eng work.` +
          "\n\nSkills: Go\n\nTarget roles: Staff Engineer",
      ],
      { inputType: "query" },
    );

    const rows = await readProfiles(a);
    expect(rows).toHaveLength(1);
    // Exact persisted shape: email + phone each redacted, the NUL stripped at write (an un-stripped
    // NUL would have ABORTED the whole insert — Postgres jsonb rejects U+0000), blank skill dropped.
    expect(rows[0]!.structured).toStrictEqual({
      summary: "Contact [redacted] or [redacted] for SrEng work.",
      skills: ["Go"],
      targetRoles: ["Staff Engineer"],
    });
    expect(rows[0]!.sourceCvFileId).toBe(cvId);
  });

  it("throws no-embeddable-content on an all-blank structured profile and leaves a pre-existing profile row byte-identical — the throw precedes the upsert", async () => {
    const a = await seedUser(1);
    const cvId = await seedCvFile(a, { status: "extracted", r2TextKey: "cv/text/a.txt" });
    await seedProfileRow(
      a,
      cvId,
      { summary: "previous profile", skills: ["Rust"], targetRoles: ["Platform"] },
      oneHot(1),
    );
    const before = await readProfiles(a);
    expect(before).toHaveLength(1);

    const { storage } = fakeStorage(transcriptMap({ "cv/text/a.txt": "transcript body" }));
    // Genuinely blank/whitespace fields: scrub trims all three to empty → composeProfileText === "".
    // (An email-only summary would NOT work here — it scrubs to '[redacted]', which is non-empty.)
    const structure = stubStructure({ summary: "   ", skills: [], targetRoles: ["  "] });
    const embed = stubEmbed();

    const err = await rejectionOf(restructureProfile(db, { structure, embed, storage }, a));
    expect(err.message).toBe("restructureProfile: re-structured profile had no embeddable content");

    expect(embed).not.toHaveBeenCalled(); // never send an empty string to the embedder
    // All-or-nothing: the throw fired before upsertUserProfile, so the existing row is untouched.
    expect(await readProfiles(a)).toStrictEqual(before);
  });

  it("propagates embedQuery no-usable-vector rejection (seam returns []) and writes nothing", async () => {
    const a = await seedUser(1);
    await seedCvFile(a, { status: "extracted", r2TextKey: "cv/text/a.txt" });
    const { storage } = fakeStorage(transcriptMap({ "cv/text/a.txt": "transcript body" }));
    const embed = vi.fn<ProfileEmbedFn>(async () => ({ embeddings: [], usage: { totalTokens: 0 } }));

    const err = await rejectionOf(
      restructureProfile(db, { structure: stubStructure(CLEAN_PROFILE), embed, storage }, a),
    );
    expect(err.message).toBe("embed() returned no usable vector for the profile text");
    expect(await readProfiles(a)).toHaveLength(0);
  });

  it("rejects with the vectorLiteral dimension message (match /dimensions, got 3/, never a hardcoded width) when the embed seam returns a wrong-width vector — no row written", async () => {
    const a = await seedUser(1);
    await seedCvFile(a, { status: "extracted", r2TextKey: "cv/text/a.txt" });
    const { storage } = fakeStorage(transcriptMap({ "cv/text/a.txt": "transcript body" }));
    const embed = stubEmbed([1, 2, 3]); // passes embedQuery (no width check there) …

    const err = await rejectionOf(
      restructureProfile(db, { structure: stubStructure(CLEAN_PROFILE), embed, storage }, a),
    );
    // … and fails in vectorLiteral while BUILDING the insert values — a plain JS throw before any
    // SQL executes, so the message is matched directly (no err.cause). The expected width is
    // \d+ (never embedded in the matcher) so a dimension-constant change can't break this test.
    expect(err.message).toMatch(/^vectorLiteral: expected \d+ dimensions, got 3$/);
    expect(await readProfiles(a)).toHaveLength(0);
  });

  it("INSERTs a fresh profile row when none exists — the all-blank-ingest recovery case: scrubbed structured, round-tripped embedding, sourceCvFileId = latest extracted upload", async () => {
    const a = await seedUser(1);
    const cvId = await seedCvFile(a, { status: "extracted", r2TextKey: "cv/text/a.txt" });
    // NO user_profiles row seeded: exactly the state an all-blank ingest leaves behind (extracted
    // cv_file, cached transcript, no profile) — the whole point of the re-run seam.
    const { storage } = fakeStorage(transcriptMap({ "cv/text/a.txt": "transcript body" }));
    const vector = oneHot(2);

    await expect(
      restructureProfile(
        db,
        { structure: stubStructure(CLEAN_PROFILE), embed: stubEmbed(vector), storage },
        a,
      ),
    ).resolves.toBeUndefined(); // void return — usage tokens are deliberately discarded

    const rows = await readProfiles(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.structured).toStrictEqual(CLEAN_PROFILE);
    // Drizzle's typed vector column round-trips the stored pgvector back to number[].
    expect(rows[0]!.embedding).toEqual(vector);
    expect(rows[0]!.sourceCvFileId).toBe(cvId);
  });

  it("UPDATEs the one existing row on re-run — structured/embedding/sourceCvFileId replaced, planted past updatedAt sentinel moves, exactly one row remains", async () => {
    const a = await seedUser(1);
    await seedCvFile(a, { status: "extracted", r2TextKey: "cv/text/v1.txt" });
    const { storage } = fakeStorage(
      transcriptMap({ "cv/text/v1.txt": "first transcript", "cv/text/v2.txt": "second transcript" }),
    );
    await restructureProfile(
      db,
      { structure: stubStructure(CLEAN_PROFILE), embed: stubEmbed(oneHot(3)), storage },
      a,
    );
    const firstRun = (await readProfiles(a))[0]!;

    // Plant an EXPLICIT past sentinel — never compare two near-identical now() stamps (flaky when
    // insert and update land in the same millisecond).
    const planted = new Date("2026-01-01T00:00:00Z");
    await db.update(userProfiles).set({ updatedAt: planted }).where(eq(userProfiles.userId, a));

    // A newer extracted upload + a changed structuring output → the re-run must REPLACE in place.
    const cv2 = await seedCvFile(a, { status: "extracted", r2TextKey: "cv/text/v2.txt" });
    const profileV2: StructuredProfile = {
      summary: "Platform engineer moving into infrastructure.",
      skills: ["Kubernetes"],
      targetRoles: ["Staff Platform Engineer"],
    };
    await restructureProfile(
      db,
      { structure: stubStructure(profileV2), embed: stubEmbed(oneHot(4)), storage },
      a,
    );

    const rows = await readProfiles(a);
    expect(rows).toHaveLength(1); // upserted, not accumulated
    const row = rows[0]!;
    expect(row.id).toBe(firstRun.id); // the SAME row updated in place, not delete+insert
    expect(row.structured).toStrictEqual(profileV2);
    expect(row.embedding).toEqual(oneHot(4));
    expect(row.sourceCvFileId).toBe(cv2);
    // now() replaced the planted sentinel — the upsert's SET bumps updated_at on every conflict.
    expect(row.updatedAt.getTime()).toBeGreaterThan(planted.getTime());
  });

  it("bystander: user B pre-existing profile row untouched and B newer extracted upload never selected for A — the upsert conflict target and the userId WHERE both hold", async () => {
    const a = await seedUser(1);
    const b = await seedUser(2);
    const cvA = await seedCvFile(a, { status: "extracted", r2TextKey: "cv/text/a.txt" });
    // B's extracted upload has a HIGHER id than A's — a getProfileTextKey missing its userId WHERE
    // would pick B's row for A (ORDER BY id DESC), observable in both the key and sourceCvFileId.
    const cvB = await seedCvFile(b, { status: "extracted", r2TextKey: "cv/text/b.txt" });
    expect(cvB).toBeGreaterThan(cvA);
    await seedProfileRow(
      b,
      cvB,
      { summary: "B's own profile", skills: ["Java"], targetRoles: ["Data Engineer"] },
      oneHot(5),
    );
    const bBefore = await readProfiles(b);
    expect(bBefore).toHaveLength(1);

    const { storage, getObjectKeys } = fakeStorage(
      transcriptMap({ "cv/text/a.txt": "transcript A", "cv/text/b.txt": "transcript B" }),
    );
    await restructureProfile(
      db,
      { structure: stubStructure(CLEAN_PROFILE), embed: stubEmbed(oneHot(6)), storage },
      a,
    );

    // A's run read A's upload only, and wrote A's own row …
    expect(getObjectKeys).toEqual(["cv/text/a.txt"]);
    const aRows = await readProfiles(a);
    expect(aRows).toHaveLength(1);
    expect(aRows[0]!.sourceCvFileId).toBe(cvA);
    // … while B's whole row (structured, embedding, sourceCvFileId, timestamps) is untouched — the
    // ON CONFLICT (user_id) target scoped the write to A. Without this bystander, a scoped and an
    // unscoped upsert are observationally identical.
    expect(await readProfiles(b)).toStrictEqual(bBefore);
  });

  it("read-only collaborators: putObject/deleteObject/close never called; user_cv_files rows unchanged after a successful run", async () => {
    const a = await seedUser(1);
    await seedCvFile(a, { status: "failed", r2TextKey: null }); // history row with a failure
    await seedCvFile(a, { status: "extracted", r2TextKey: "cv/text/a.txt" });
    const cvBefore = await readCvFiles(a);
    expect(cvBefore).toHaveLength(2);

    const { storage, getObjectKeys, putObject, deleteObject, close: closeSpy } = fakeStorage(
      transcriptMap({ "cv/text/a.txt": "transcript body" }),
    );
    await restructureProfile(
      db,
      { structure: stubStructure(CLEAN_PROFILE), embed: stubEmbed(), storage },
      a,
    );

    // The pipeline READS the transcript and nothing else: it must not write/delete R2 objects, and
    // must NOT close a client it didn't create (the constructing script owns the lifecycle).
    expect(getObjectKeys).toEqual(["cv/text/a.txt"]);
    expect(putObject).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
    // Upload history is append-only from this seam's perspective — statuses/keys/errors unchanged.
    expect(await readCvFiles(a)).toStrictEqual(cvBefore);
  });
});
