import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@opusfinder/db";
import { user, userCvFiles, userProfiles } from "@opusfinder/db/schema";
import { MIN_TRANSCRIPT_CHARS, type StructuredProfile, type UserId } from "@opusfinder/shared";
import type { PutObjectInput, StorageClient } from "@opusfinder/storage";

import { createTestDb } from "@test/db/pglite";
import { oneHot } from "@test/db/vectors";

import { ingestCv, type IngestCvOptions } from "./ingest";
import type { ProfileEmbedFn, StructureFn, TranscribeFn } from "./types";

// What this file proves: the FULL ingestCv pipeline — provisional-insert-first ordering, the R2 key
// discipline (one uploadId across both keys, persisted not re-derived), the trimmed-length transcript
// gate at its exact boundary, RAW-untrimmed transcript caching, the cache-before-patch ordering
// (a put#2-only outage), the in-pipeline PII scrub (persisted jsonb AND embed input), the
// empty-content early return, warnings pass-through on the embed path, the embedQuery unwrap guard,
// NUL stripping (error_sample + insert columns), the catch-path row signatures (pre-extraction /
// post-extraction ne-guard / mark-swallow), the latest-CV-wins profile upsert, and the FK precondition — with stub transcribe/structure/embed/storage seams
// against real PGlite persistence (zero HTTP; MSW loads but nothing egresses). NOT this file's job:
// the profiles repo's read fns (getProfileTextKey is owned by restructure.integration.test.ts;
// getProfileForDigest by packages/db/src/repos/profiles.integration.test.ts) and live neon-http
// driver parity (deferred with the 5b live-gate work).

/** Explicit deterministic uuid per seeded user (the digests suite's idiom) — never gen_random_uuid(). */
function uid(n: number): UserId {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as UserId;
}

const A = uid(1);
const B = uid(2);

const UUID_SEG = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 fake bytes");

// Padded on BOTH ends: the length gate trims (ingest.ts) but the cached object must be the RAW seam
// output — the padding is what makes the untrimmed-store assertions non-vacuous.
const HAPPY_TRANSCRIPT = `  Career history of a senior backend engineer. ${"x".repeat(
  MIN_TRANSCRIPT_CHARS * 3,
)}  `;

// PII-free and already scrub-normalized (no doubled spaces, no leading/trailing whitespace), so
// scrubProfilePii is an identity on it and the persisted jsonb can be compared to it directly.
const FULL_PROFILE: StructuredProfile = {
  summary: "Senior backend engineer building high-throughput payment systems.",
  skills: ["Go", "PostgreSQL", "Kubernetes"],
  targetRoles: ["Senior Backend Engineer"],
};
// Hardcoded (NOT computed via composeProfileText) so a composition regression cannot rewrite the
// expectation along with the behavior.
const FULL_PROFILE_EMBED_TEXT =
  "Senior backend engineer building high-throughput payment systems.\n\n" +
  "Skills: Go, PostgreSQL, Kubernetes\n\n" +
  "Target roles: Senior Backend Engineer";

const PII_EMAIL = "jane.doe@example.com";
const PII_PHONE = "+1 (555) 123-4567"; // 11 digits — past the >=10-digit redaction floor
const PII_PROFILE: StructuredProfile = {
  summary: `Reach me at ${PII_EMAIL} or ${PII_PHONE} for backend roles.`,
  // "   " scrubs to "" and must be FILTERED from skills; the email-bearing skill scrubs to a
  // non-empty "[redacted]" form and must be KEPT (redaction, not removal).
  skills: ["Go", `email: ${PII_EMAIL}`, "   "],
  targetRoles: ["Backend Engineer"],
};
const SCRUBBED_PROFILE: StructuredProfile = {
  summary: "Reach me at [redacted] or [redacted] for backend roles.",
  skills: ["Go", "email: [redacted]"],
  targetRoles: ["Backend Engineer"],
};
const SCRUBBED_EMBED_TEXT =
  "Reach me at [redacted] or [redacted] for backend roles.\n\n" +
  "Skills: Go, email: [redacted]\n\n" +
  "Target roles: Backend Engineer";

const SECOND_PROFILE: StructuredProfile = {
  summary: "Data engineer focused on streaming pipelines.",
  skills: ["Python", "Kafka"],
  targetRoles: ["Data Engineer"],
};

interface StorageSpy {
  client: StorageClient;
  /** Ordered putObject call log — index 0 must be the original, index 1 the transcript. */
  puts: PutObjectInput[];
}

/** Map-backed StorageClient SPY (port of the retired script's memoryStorage, plus the call log). */
function spyStorage(
  opts: {
    /** Runs BEFORE the call is recorded — the in-flight DB probe hook for the ordering test. */
    onPut?: (input: PutObjectInput, callIndex: number) => Promise<void> | void;
    /** When set, every putObject rejects with this error (arms the pre-extraction catch path). */
    rejectWith?: Error;
  } = {},
): StorageSpy {
  const puts: PutObjectInput[] = [];
  const store = new Map<string, Uint8Array | string>();
  return {
    puts,
    client: {
      async putObject(input) {
        if (opts.rejectWith) throw opts.rejectWith;
        await opts.onPut?.(input, puts.length);
        puts.push(input);
        store.set(input.key, input.body);
      },
      async getObject(key) {
        const body = store.get(key);
        if (body === undefined) return null;
        return typeof body === "string" ? new TextEncoder().encode(body) : body;
      },
      async deleteObject(key) {
        store.delete(key);
      },
      close() {},
    },
  };
}

function stubTranscribe(text: string = HAPPY_TRANSCRIPT) {
  return vi.fn<TranscribeFn>(async () => text);
}

function stubStructure(profile: StructuredProfile = FULL_PROFILE) {
  return vi.fn<StructureFn>(async () => profile);
}

/** Embed stub: oneHot vectors (EMBEDDING_DIMENSIONS-sized, exact float4 round-trip) + the retired
 *  script's usage.totalTokens=42 sentinel, surfaced verbatim as result.embedTokens. */
function stubEmbed(vec: number[] = oneHot(3)) {
  return vi.fn<ProfileEmbedFn>(async (texts) => ({
    embeddings: texts.map(() => vec),
    usage: { totalTokens: 42 },
  }));
}

describe("ingestCv — CV → profile pipeline (stub seams, real PGlite persistence)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    // Truncate ONLY the tables this file touches; the reserved "user" table is interpolated as a
    // drizzle table object so quoting is never hand-rolled.
    await db.execute(
      sql`TRUNCATE TABLE ${userProfiles}, ${userCvFiles}, ${user} RESTART IDENTITY CASCADE`,
    );
    // The user_cv_files/user_profiles → user.id FK needs real rows; unique emails (user_email_uq).
    await db.insert(user).values([
      { id: A, name: "User A", email: "user-a@test.local", emailVerified: true },
      { id: B, name: "User B", email: "user-b@test.local", emailVerified: true },
    ]);
  });
  afterAll(async () => {
    // Optional-chained: if beforeAll's createTestDb() rejected, a bare close() would bury the real
    // failure under a secondary TypeError. Drains the WASM handle → clean Windows teardown.
    await close?.();
  });

  function ingestOpts(
    storage: StorageClient,
    over: Partial<IngestCvOptions> = {},
  ): IngestCvOptions {
    return {
      userId: A,
      bytes: PDF_BYTES,
      // Distinctive values a hardcoding mutation would never guess: 'application/pdf'/'cv.pdf' are
      // exactly the literals a lazy hardcode of the pass-through would use, so they can't be fixtures.
      filename: "résumé-final-v2.pdf",
      contentType: "application/x-opusfinder-test",
      transcribe: stubTranscribe(),
      structure: stubStructure(),
      embed: stubEmbed(),
      storage,
      ...over,
    };
  }

  async function seedCvFile(
    userId: UserId,
    over: Partial<typeof userCvFiles.$inferInsert> = {},
  ): Promise<number> {
    const rows = await db
      .insert(userCvFiles)
      .values({
        userId,
        r2OriginalKey: "bystander/original.pdf",
        filename: "bystander.pdf",
        contentType: "application/pdf",
        byteSize: 10,
        ...over,
      })
      .returning({ id: userCvFiles.id });
    const row = rows[0];
    if (!row) throw new Error("seedCvFile returned no row");
    return row.id;
  }

  async function seedProfile(
    userId: UserId,
    sourceCvFileId: number,
    over: Partial<typeof userProfiles.$inferInsert> = {},
  ): Promise<number> {
    const rows = await db
      .insert(userProfiles)
      .values({
        userId,
        structured: { summary: "bystander profile", skills: ["Rust"], targetRoles: ["SRE"] },
        embedding: oneHot(7), // distinct from every vector the tests ingest for A
        sourceCvFileId,
        ...over,
      })
      .returning({ id: userProfiles.id });
    const row = rows[0];
    if (!row) throw new Error("seedProfile returned no row");
    return row.id;
  }

  interface Bystanders {
    /** [B's failed cv row, A's OLDER extracted row, A's OLDER failed row] */
    cvIds: number[];
    before: {
      cv: (typeof userCvFiles.$inferSelect)[];
      profiles: (typeof userProfiles.$inferSelect)[];
    };
  }

  async function snapshotBystanders(cvIds: number[]): Promise<Bystanders["before"]> {
    return {
      cv: await db
        .select()
        .from(userCvFiles)
        .where(inArray(userCvFiles.id, cvIds))
        .orderBy(userCvFiles.id),
      profiles: await db
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, B))
        .orderBy(userProfiles.id),
    };
  }

  /** The scoped-write tripwires. B's failed row + B's profile catch a mark/patch/upsert that lost its
   *  user scope; A's OLDER extracted row catches a mark that lost the ne(status,'extracted') guard;
   *  A's OLDER failed row catches a mark/patch that lost the eq(id, fileId) half of its WHERE. */
  async function seedBystanders(): Promise<Bystanders> {
    const bCv = await seedCvFile(B, { status: "failed", errorSample: "b-preexisting-failure" });
    await seedProfile(B, bCv);
    const aExtracted = await seedCvFile(A, { status: "extracted", r2TextKey: "text/a-older.txt" });
    const aFailed = await seedCvFile(A, { status: "failed", errorSample: "a-older-failure" });
    const cvIds = [bCv, aExtracted, aFailed];
    return { cvIds, before: await snapshotBystanders(cvIds) };
  }

  async function expectBystandersUnchanged(byst: Bystanders): Promise<void> {
    expect(await snapshotBystanders(byst.cvIds)).toEqual(byst.before);
  }

  async function readCvFile(id: number) {
    const rows = await db.select().from(userCvFiles).where(eq(userCvFiles.id, id));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  /** A user's cv rows minus the seeded bystanders — how tests locate the row an ingest created when
   *  the pipeline rejected (no result.fileId to read back). */
  async function cvRowsFor(userId: UserId, excludeIds: number[] = []) {
    const rows = await db
      .select()
      .from(userCvFiles)
      .where(eq(userCvFiles.userId, userId))
      .orderBy(userCvFiles.id);
    return rows.filter((r) => !excludeIds.includes(r.id));
  }

  async function readProfiles(userId: UserId) {
    return db.select().from(userProfiles).where(eq(userProfiles.userId, userId));
  }

  it("happy path — extracts, embeds, and upserts the profile; both R2 keys share ONE uploadId and are persisted on the row", async () => {
    const byst = await seedBystanders();
    const embed = stubEmbed(oneHot(3));
    const { client } = spyStorage();

    const result = await ingestCv(db, ingestOpts(client, { embed }));

    expect(result.status).toBe("extracted");
    expect(result.embedTokens).toBe(42); // the seam's usage.totalTokens, surfaced VERBATIM
    expect(result.warnings).toEqual([]); // a full profile yields zero profileWarnings
    expect(result.profileId).toBeDefined();

    const row = await readCvFile(result.fileId);
    expect(row.userId).toBe(A);
    expect(row.status).toBe("extracted");
    expect(row.errorSample).toBeNull();
    expect(row.filename).toBe("résumé-final-v2.pdf"); // the CALLER's filename, passed through
    expect(row.contentType).toBe("application/x-opusfinder-test");
    expect(row.byteSize).toBe(PDF_BYTES.byteLength);

    // Key discipline: originals/{userId}/{uuid}.pdf + text/{userId}/{uuid}.txt — the uploadId is
    // nondeterministic, so assert the pattern and that BOTH keys embed the SAME uuid segment.
    const orig = new RegExp(`^originals/${A}/(${UUID_SEG})\\.pdf$`).exec(row.r2OriginalKey);
    const text = new RegExp(`^text/${A}/(${UUID_SEG})\\.txt$`).exec(row.r2TextKey ?? "");
    expect(orig).not.toBeNull();
    expect(text).not.toBeNull();
    expect(orig![1]).toBe(text![1]);

    // The embed input pins composeProfileText's composition (summary, labeled skills, labeled roles,
    // blank-line joins) and the single-element/query-side call shape.
    expect(embed).toHaveBeenCalledExactlyOnceWith([FULL_PROFILE_EMBED_TEXT], {
      inputType: "query",
    });

    const profiles = await readProfiles(A);
    expect(profiles).toHaveLength(1);
    const profile = profiles[0]!;
    expect(profile.id).toBe(result.profileId);
    expect(profile.structured).toEqual(FULL_PROFILE); // scrub is identity on the clean fixture
    expect(profile.embedding).toEqual(oneHot(3)); // exact float4 round-trip of the seam's vector
    expect(profile.sourceCvFileId).toBe(result.fileId);

    // B's profile byte-identical + A's older rows untouched (patch kept its id AND user scope).
    await expectBystandersUnchanged(byst);
  });

  it("writes exactly two storage objects in order — the original bytes, then the RAW UNTRIMMED transcript — under the persisted keys", async () => {
    const byst = await seedBystanders();
    const transcribe = stubTranscribe();
    const { client, puts } = spyStorage();

    const result = await ingestCv(db, ingestOpts(client, { transcribe }));

    expect(transcribe).toHaveBeenCalledExactlyOnceWith(PDF_BYTES); // transcribe gets the ORIGINAL bytes
    const row = await readCvFile(result.fileId);
    expect(puts).toHaveLength(2);
    expect(puts[0]).toEqual({
      key: row.r2OriginalKey, // spy key ⇄ persisted column — the key is stored, never re-derived
      body: PDF_BYTES,
      contentType: "application/x-opusfinder-test", // the CALLER's contentType, passed through
    });
    expect(puts[1]).toEqual({
      key: row.r2TextKey,
      body: HAPPY_TRANSCRIPT, // the raw seam output — the gate trims, the cache must NOT
      contentType: "text/plain; charset=utf-8",
    });
    // Fixture guard: padding present, so the untrimmed-body assertion above cannot pass vacuously.
    expect(HAPPY_TRANSCRIPT).not.toBe(HAPPY_TRANSCRIPT.trim());
    await expectBystandersUnchanged(byst);
  });

  it("inserts the provisional 'failed' row BEFORE the first storage write — the upload spy observes it in-flight", async () => {
    let observed: { status: string; errorSample: string | null }[] | undefined;
    let observedKey: string | undefined;
    const { client } = spyStorage({
      onPut: async (input, callIndex) => {
        if (callIndex === 0) {
          observedKey = input.key;
          observed = await db
            .select({ status: userCvFiles.status, errorSample: userCvFiles.errorSample })
            .from(userCvFiles)
            .where(and(eq(userCvFiles.userId, A), eq(userCvFiles.r2OriginalKey, input.key)));
        }
      },
    });

    const result = await ingestCv(db, ingestOpts(client));

    expect(result.status).toBe("extracted"); // the probe ran mid-HAPPY-path, not on a failure
    // A row keyed by the upload's own key ALREADY existed, provisionally 'failed', at upload time.
    expect(observed).toEqual([{ status: "failed", errorSample: null }]);
    expect(observedKey).toBe((await readCvFile(result.fileId)).r2OriginalKey);
  });

  it("fails a transcript whose TRIMMED length is one under the floor — whitespace padding does not count", async () => {
    const byst = await seedBystanders();
    // Untrimmed length clears the floor — ONLY the trim() can fail this fixture.
    const shortText = `  ${"x".repeat(MIN_TRANSCRIPT_CHARS - 1)}  `;
    const transcribe = stubTranscribe(shortText);
    const structure = stubStructure();
    const embed = stubEmbed();
    const { client, puts } = spyStorage();

    const result = await ingestCv(db, ingestOpts(client, { transcribe, structure, embed }));

    expect(result.status).toBe("failed");
    expect(result.profileId).toBeUndefined();
    expect(result.embedTokens).toBe(0);
    expect(result.warnings).toEqual([
      "transcript too short — corrupt, encrypted, or image-only PDF?",
    ]);

    const row = await readCvFile(result.fileId);
    expect(row.status).toBe("failed");
    // The persisted sample reports the TRIMMED length, built here from the constant, never a literal.
    expect(row.errorSample).toBe(
      `transcription returned too little text (${MIN_TRANSCRIPT_CHARS - 1} chars)`,
    );
    expect(row.r2TextKey).toBeNull();

    expect(puts).toHaveLength(1); // the original only — the transcript is never cached
    expect(structure).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(await readProfiles(A)).toHaveLength(0);

    await expectBystandersUnchanged(byst);
  });

  it("proceeds at exactly the floor — MIN_TRANSCRIPT_CHARS trimmed chars (whitespace-padded) reach 'extracted'", async () => {
    const byst = await seedBystanders();
    const boundary = `\n ${"y".repeat(MIN_TRANSCRIPT_CHARS)} \n`;
    const { client, puts } = spyStorage();

    const result = await ingestCv(db, ingestOpts(client, { transcribe: stubTranscribe(boundary) }));

    expect(result.status).toBe("extracted"); // the gate is strict-less-than, not <=
    const row = await readCvFile(result.fileId);
    expect(row.status).toBe("extracted");
    expect(row.r2TextKey).not.toBeNull();
    expect(puts[1]?.body).toBe(boundary); // raw untrimmed cache holds at the boundary too
    await expectBystandersUnchanged(byst);
  });

  it("scrubs PII BEFORE persisting and embedding — email + phone redacted in the stored jsonb AND the embed input", async () => {
    const byst = await seedBystanders();
    const structure = stubStructure(PII_PROFILE);
    const embed = stubEmbed();
    const { client } = spyStorage();

    const result = await ingestCv(db, ingestOpts(client, { structure, embed }));

    // structure() receives the RAW transcript — the scrub lives in the PIPELINE, not the seam.
    expect(structure).toHaveBeenCalledExactlyOnceWith(HAPPY_TRANSCRIPT);
    expect(embed).toHaveBeenCalledExactlyOnceWith([SCRUBBED_EMBED_TEXT], { inputType: "query" });
    const embedText = (embed.mock.calls[0]![0] as string[])[0]!;
    expect(embedText).toContain("[redacted]");
    expect(embedText).not.toContain(PII_EMAIL);
    expect(embedText).not.toContain("123-4567");

    const profiles = await readProfiles(A);
    expect(profiles).toHaveLength(1);
    // Exact scrubbed shape: email→[redacted], >=10-digit phone→[redacted], the whitespace-only skill
    // FILTERED out, the email-bearing skill KEPT in redacted form.
    expect(profiles[0]!.structured).toEqual(SCRUBBED_PROFILE);
    const persisted = JSON.stringify(profiles[0]!.structured);
    expect(persisted).not.toContain(PII_EMAIL);
    expect(persisted).not.toContain("123-4567");
    expect(result.warnings).toEqual([]);

    await expectBystandersUnchanged(byst);
  });

  it("empty embeddable content — exact 4-warning array, embed never called, no profile row, transcript still cached", async () => {
    const byst = await seedBystanders();
    const structure = stubStructure({ summary: "", skills: [], targetRoles: [] });
    const embed = stubEmbed();
    const { client, puts } = spyStorage();

    const result = await ingestCv(db, ingestOpts(client, { structure, embed }));

    expect(result.status).toBe("extracted");
    expect(result.profileId).toBeUndefined();
    expect(result.embedTokens).toBe(0);
    // The exact ordered array pins BOTH the profileWarnings spread and the appended sentinel.
    expect(result.warnings).toEqual([
      "empty summary",
      "no skills extracted",
      "no target roles extracted",
      "profile had no embeddable content — not embedded",
    ]);
    expect(embed).not.toHaveBeenCalled(); // an empty string must never reach the embedder
    expect(await readProfiles(A)).toHaveLength(0);

    const row = await readCvFile(result.fileId);
    expect(row.status).toBe("extracted"); // the cached transcript stands
    expect(row.r2TextKey).toBe(puts[1]!.key);
    expect(row.errorSample).toBeNull();

    await expectBystandersUnchanged(byst);
  });

  it("a PARTIAL profile that still embeds surfaces its warnings on the SUCCESS return", async () => {
    const byst = await seedBystanders();
    // Non-empty summary + skills → embeddable; empty targetRoles → exactly one profileWarning. The
    // only fixture where the success return's `warnings` is non-empty — a `warnings: []` hardcode on
    // that return is invisible to every other embed-path test.
    const structure = stubStructure({
      summary: "Backend engineer exploring new roles.",
      skills: ["Go"],
      targetRoles: [],
    });
    const { client } = spyStorage();

    const result = await ingestCv(db, ingestOpts(client, { structure }));

    expect(result.status).toBe("extracted");
    expect(result.profileId).toBeDefined(); // the thin profile still embeds + upserts...
    expect(result.warnings).toEqual(["no target roles extracted"]); // ...and the warnings pass through
    expect(await readProfiles(A)).toHaveLength(1);

    await expectBystandersUnchanged(byst);
  });

  it("embed returning { embeddings: [] } rejects via the unwrap guard — row STAYS 'extracted', error_sample NULL", async () => {
    const byst = await seedBystanders();
    const embed = vi.fn<ProfileEmbedFn>(async () => ({
      embeddings: [],
      usage: { totalTokens: 42 },
    }));
    const { client, puts } = spyStorage();

    const err = await ingestCv(db, ingestOpts(client, { embed })).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeNull();
    // Plain JS throw (embedQuery, before any SQL) — exact message, not the drizzle wrapper idiom.
    expect(err!.message).toBe("embed() returned no usable vector for the profile text");

    const rows = await cvRowsFor(A, byst.cvIds);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("extracted"); // ne(status,'extracted') matched ZERO rows
    expect(rows[0]!.errorSample).toBeNull(); // assert the NULL — the mark wrote NOTHING, not just no flip
    expect(rows[0]!.r2TextKey).toBe(puts[1]!.key); // the cached transcript survives the failure
    expect(await readProfiles(A)).toHaveLength(0);

    await expectBystandersUnchanged(byst);
  });

  it("embed returning { embeddings: [[]] } (a zero-length vector) rejects via the same guard", async () => {
    const byst = await seedBystanders();
    const embed = vi.fn<ProfileEmbedFn>(async () => ({
      embeddings: [[]],
      usage: { totalTokens: 42 },
    }));
    const { client } = spyStorage();

    const err = await ingestCv(db, ingestOpts(client, { embed })).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeNull();
    // Kills the guard's second arm independently: `!vector` alone would let [[]] through.
    expect(err!.message).toBe("embed() returned no usable vector for the profile text");
    expect(await readProfiles(A)).toHaveLength(0);

    await expectBystandersUnchanged(byst);
  });

  it("pre-extraction failure (transcribe rejects) re-throws the ORIGINAL error and stores a 500-char truncated error_sample", async () => {
    const byst = await seedBystanders();
    const boom = new Error("e".repeat(600));
    const transcribe = vi.fn<TranscribeFn>(() => Promise.reject(boom));
    const structure = stubStructure();
    const { client, puts } = spyStorage();

    const err = await ingestCv(db, ingestOpts(client, { transcribe, structure })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBe(boom); // identity — never a wrapped or secondary error

    const rows = await cvRowsFor(A, byst.cvIds);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.errorSample).toBe("e".repeat(500)); // MAX_ERROR_SAMPLE truncation: exactly 500 of 600
    expect(rows[0]!.r2TextKey).toBeNull();
    expect(puts).toHaveLength(1); // the original uploaded; no transcript object exists
    expect(structure).not.toHaveBeenCalled();
    expect(await readProfiles(A)).toHaveLength(0);

    await expectBystandersUnchanged(byst);
  });

  it("a failure DURING the original upload lands on the provisional row — the storage error becomes error_sample and re-throws", async () => {
    const byst = await seedBystanders();
    const outage = new Error("r2 unavailable: simulated outage");
    const transcribe = stubTranscribe();
    const { client, puts } = spyStorage({ rejectWith: outage });

    const err = await ingestCv(db, ingestOpts(client, { transcribe })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBe(outage);
    expect(puts).toHaveLength(0); // the put rejected before recording anything
    expect(transcribe).not.toHaveBeenCalled(); // upload precedes transcription

    const rows = await cvRowsFor(A, byst.cvIds);
    expect(rows).toHaveLength(1); // the provisional insert PRECEDED the failing upload
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.errorSample).toBe("r2 unavailable: simulated outage");
    expect(rows[0]!.r2TextKey).toBeNull();

    await expectBystandersUnchanged(byst);
  });

  it("a failure during the TRANSCRIPT upload (put#2 ONLY) lands before the patch — row stays 'failed', r2_text_key NULL", async () => {
    const byst = await seedBystanders();
    const outage = new Error("r2 unavailable: transcript write failed");
    // Rejects ONLY callIndex 1 (the transcript put) — the original upload succeeds. This is the one
    // fixture that discriminates the cache-then-patch ordering: patch-first would flip the row to
    // 'extracted' with an r2_text_key pointing at an object that was NEVER written, and the catch's
    // mark would then be blocked by the ne-guard.
    const { client, puts } = spyStorage({
      onPut: (_input, callIndex) => {
        if (callIndex === 1) throw outage;
      },
    });

    const err = await ingestCv(db, ingestOpts(client)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBe(outage);
    expect(puts).toHaveLength(1); // only the original landed — put#2 rejected before recording

    const rows = await cvRowsFor(A, byst.cvIds);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed"); // never patched — the cache write precedes the patch
    expect(rows[0]!.errorSample).toBe("r2 unavailable: transcript write failed");
    expect(rows[0]!.r2TextKey).toBeNull();
    expect(await readProfiles(A)).toHaveLength(0);

    await expectBystandersUnchanged(byst);
  });

  it("a non-Error throw records String(err) as error_sample and the bare value re-throws", async () => {
    const byst = await seedBystanders();
    const transcribe = vi.fn<TranscribeFn>(() => Promise.reject("boom-string"));
    const { client } = spyStorage();

    const err = await ingestCv(db, ingestOpts(client, { transcribe })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBe("boom-string");

    const rows = await cvRowsFor(A, byst.cvIds);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.errorSample).toBe("boom-string");

    await expectBystandersUnchanged(byst);
  });

  it("a NUL byte in the failure message is STRIPPED from the persisted error_sample", async () => {
    const byst = await seedBystanders();
    // NUL built at RUNTIME (never a literal escape in source). With the strip dropped, Postgres
    // rejects the 0x00 text, the (swallowed) mark never lands, and error_sample would read NULL.
    const nulError = new Error("nul" + String.fromCharCode(0) + "sample");
    const transcribe = vi.fn<TranscribeFn>(() => Promise.reject(nulError));
    const { client } = spyStorage();

    const err = await ingestCv(db, ingestOpts(client, { transcribe })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBe(nulError); // the original error still propagates, NUL and all

    const rows = await cvRowsFor(A, byst.cvIds);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.errorSample).toBe("nulsample"); // hand-written NUL-free literal

    await expectBystandersUnchanged(byst);
  });

  it("a NUL byte in the caller's filename is STRIPPED before the insert — the persisted column is NUL-free", async () => {
    const byst = await seedBystanders();
    // Runtime-built NUL mid-filename. Postgres text columns reject 0x00 outright, so with
    // insertCvFile's per-field strip dropped the provisional insert itself fails the whole ingest.
    const nulFilename = "cv" + String.fromCharCode(0) + "file.pdf";
    const { client } = spyStorage();

    const result = await ingestCv(db, ingestOpts(client, { filename: nulFilename }));

    expect(result.status).toBe("extracted");
    const row = await readCvFile(result.fileId);
    expect(row.filename).toBe("cvfile.pdf"); // hand-written NUL-free literal

    await expectBystandersUnchanged(byst);
  });

  it("post-extraction failure (structure rejects) leaves the row 'extracted' with error_sample NULL and the existing profile untouched", async () => {
    const byst = await seedBystanders();
    // A already has a profile from an earlier CV (backed by A's older extracted upload) — the
    // failure must not touch it.
    const aExistingProfileId = await seedProfile(A, byst.cvIds[1]!, {
      structured: { summary: "existing profile for A", skills: ["Go"], targetRoles: ["Backend"] },
      embedding: oneHot(9),
    });
    const profileBefore = (await readProfiles(A))[0]!;
    const boom = new Error("structure exploded");
    const structure = vi.fn<StructureFn>(() => Promise.reject(boom));
    const embed = stubEmbed();
    const { client, puts } = spyStorage();

    const err = await ingestCv(db, ingestOpts(client, { structure, embed })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBe(boom);

    const rows = await cvRowsFor(A, byst.cvIds);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("extracted"); // the catch fired, but the ne-guard matched ZERO rows
    expect(rows[0]!.errorSample).toBeNull(); // NOT just the status — the mark wrote nothing at all
    expect(rows[0]!.r2TextKey).toBe(puts[1]!.key); // the cached transcript stands
    expect(embed).not.toHaveBeenCalled();

    const profilesAfter = await readProfiles(A);
    expect(profilesAfter).toEqual([profileBefore]); // the OLD profile row, byte-identical — no new row
    expect(profilesAfter[0]!.id).toBe(aExistingProfileId);

    await expectBystandersUnchanged(byst);
  });

  it("a failing markCvFileFailed is swallowed — the ORIGINAL transcribe error propagates, never the mark's", async () => {
    const boom = new Error("transcribe exploded");
    const transcribe = vi.fn<TranscribeFn>(() => Promise.reject(boom));
    // A Proxy db that delegates everything but detonates on .update. The ONLY update on this path IS
    // markCvFileFailed (patchCvFileExtracted is never reached — transcribe rejects first), so no
    // arming flag is needed. Functions are re-bound to the real db so drizzle internals keep their
    // own `this`.
    const proxyDb = new Proxy(db as object, {
      get(target, prop) {
        if (prop === "update") throw new Error("proxy: db.update exploded");
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as unknown as Db;
    const { client } = spyStorage();

    const err = await ingestCv(proxyDb, ingestOpts(client, { transcribe })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBe(boom); // the mark's own failure must NEVER mask the real cause

    const rows = await cvRowsFor(A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed"); // still the PROVISIONAL insert value...
    expect(rows[0]!.errorSample).toBeNull(); // ...with no error_sample — the mark never landed
  });

  it("re-ingest appends a second cv_file row and refreshes the ONE profile row in place — same id, new source, bumped updated_at", async () => {
    const byst = await seedBystanders();
    const s1 = spyStorage();
    const first = await ingestCv(db, ingestOpts(s1.client, { embed: stubEmbed(oneHot(3)) }));
    expect(first.profileId).toBeDefined();

    // Planted PAST sentinel (the digests idiom): proves the upsert's sql`now()` bump without sleeping.
    const planted = new Date("2026-01-01T00:00:00Z");
    await db.update(userProfiles).set({ updatedAt: planted }).where(eq(userProfiles.userId, A));

    const s2 = spyStorage();
    const second = await ingestCv(
      db,
      ingestOpts(s2.client, {
        structure: stubStructure(SECOND_PROFILE),
        embed: stubEmbed(oneHot(5)),
      }),
    );

    expect(second.fileId).not.toBe(first.fileId);
    expect(second.profileId).toBe(first.profileId); // the SAME row updated, never a second inserted

    // Append-only upload history: both ingests' rows exist, in insertion order.
    const aCvRows = await cvRowsFor(A, byst.cvIds);
    expect(aCvRows.map((r) => r.id)).toEqual([first.fileId, second.fileId]);

    const profiles = await readProfiles(A);
    expect(profiles).toHaveLength(1); // per-user row count stays 1 — the user_id conflict target held
    const profile = profiles[0]!;
    expect(profile.id).toBe(first.profileId);
    expect(profile.structured).toEqual(SECOND_PROFILE); // latest CV wins
    expect(profile.embedding).toEqual(oneHot(5));
    expect(profile.sourceCvFileId).toBe(second.fileId); // repointed at the NEW upload
    expect(profile.updatedAt.getTime()).toBeGreaterThan(planted.getTime());

    // B's profile byte-identical through BOTH upserts (distinct structured + oneHot(7) embedding).
    await expectBystandersUnchanged(byst);
  });

  it("a never-seeded userId rejects on the FK BEFORE the try block — no row persisted, storage never called", async () => {
    const ghost = uid(99);
    const transcribe = stubTranscribe();
    const { client, puts } = spyStorage();

    const err = await ingestCv(db, ingestOpts(client, { userId: ghost, transcribe })).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeNull();
    // drizzle 0.45 wraps PG errors as 'Failed query: …' — the 23503 text lives on err.cause.
    expect(String(err!.cause ?? err)).toMatch(/foreign key|violates/i);

    expect(puts).toHaveLength(0); // the insert precedes the try AND the first storage write
    expect(transcribe).not.toHaveBeenCalled();
    expect(await db.select().from(userCvFiles)).toHaveLength(0); // nothing persisted, no mark attempted
  });
});
