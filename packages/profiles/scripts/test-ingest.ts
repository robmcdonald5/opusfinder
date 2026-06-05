// Exercises ingestCv end-to-end with STUB seams — no LLM, no Voyage, no R2 spend: an in-memory
// StorageClient plus fake transcribe / structure / embed are INJECTED into the real pipeline, run
// against the test Neon DB. This is what makes the injected-seam design pay off today: the pipeline
// is driven without any of its heavy deps. Verifies ingestCv's three control-flow paths.
//
// Writes rows under a fixed TEST user id (it does not clean up — user_cv_files is append-only by
// design, and user_profiles upserts the one test row). Requires DATABASE_URL in packages/db/.env.
// Run: pnpm --filter @opusfinder/profiles test:ingest
import { createDb } from "@opusfinder/db";
import { getDatabaseUrl } from "@opusfinder/db/env";
import { EMBEDDING_DIMENSIONS, user } from "@opusfinder/db/schema";
import type { StructuredProfile } from "@opusfinder/shared";
import { runScript } from "@opusfinder/shared/script";
import { mintUserId } from "@opusfinder/shared/userid";
import type { PutObjectInput, StorageClient } from "@opusfinder/storage";

import { ingestCv } from "../src/index";
import type { ProfileEmbedFn, StructureFn, TranscribeFn } from "../src/index";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/** A Map-backed StorageClient, so the pipeline's putObject/getObject run with no R2. */
function memoryStorage(): StorageClient & { size: () => number } {
  const store = new Map<string, Uint8Array>();
  const toBytes = (b: Uint8Array | string): Uint8Array =>
    typeof b === "string" ? new TextEncoder().encode(b) : b;
  return {
    async putObject({ key, body }: PutObjectInput) {
      store.set(key, toBytes(body));
    },
    async getObject(key: string) {
      return store.get(key) ?? null;
    },
    async deleteObject(key: string) {
      store.delete(key);
    },
    close() {},
    size: () => store.size,
  };
}

const FULL_PROFILE: StructuredProfile = {
  summary: "Senior backend engineer with ~8 years building high-throughput payment systems.",
  skills: ["Go", "PostgreSQL", "Kubernetes"],
  targetRoles: ["Senior Backend Engineer"],
};

/** Stub embed seam: a fixed-width vector per input + a token tally. No Voyage call. */
const stubEmbed: ProfileEmbedFn = async (texts) => ({
  embeddings: texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.01)),
  usage: { totalTokens: 42 },
});

const PDF = new TextEncoder().encode("%PDF-1.4 fake bytes");
const goodTranscribe: TranscribeFn = async () => "A".repeat(200); // > MIN_TRANSCRIPT_CHARS
const goodStructure: StructureFn = async () => FULL_PROFILE;

const TEST_EMAIL = "test-ingest@opusfinder.test";

async function main(): Promise<void> {
  const db = createDb(getDatabaseUrl());
  const userId = mintUserId(TEST_EMAIL);
  // The Phase-9.5 user_cv_files/user_profiles → user.id FK requires a real `user` row; seed one for
  // the deterministic test id (idempotent) so this stub smoke stays self-contained + creds-light (no
  // auth/secret — a direct insert, not signUpEmail). mintUserId is kept here purely as a stable id source.
  await db
    .insert(user)
    .values({ id: userId, name: "test-ingest", email: TEST_EMAIL, emailVerified: true })
    .onConflictDoNothing();
  const storage = memoryStorage();
  const base = { userId, bytes: PDF, filename: "cv.pdf", contentType: "application/pdf", storage };

  // (1) Happy path: real transcript -> structured profile -> embedded -> profile upserted.
  const happy = await ingestCv(db, {
    ...base,
    transcribe: goodTranscribe,
    structure: goodStructure,
    embed: stubEmbed,
  });
  console.log("[happy]          ", happy);
  assert(happy.status === "extracted", "happy: cv_file extracted");
  assert(happy.profileId !== undefined, "happy: profile written");
  assert(happy.embedTokens === 42, "happy: embed usage surfaced from the seam");
  assert(storage.size() === 2, "happy: original PDF + transcript both cached");

  // (2) Failed transcript: too-short text -> cv_file failed, no profile.
  const failed = await ingestCv(db, {
    ...base,
    transcribe: async () => "tiny",
    structure: goodStructure,
    embed: stubEmbed,
  });
  console.log("[failed-transcript]", failed);
  assert(failed.status === "failed", "short transcript -> failed");
  assert(failed.profileId === undefined, "short transcript -> no profile");

  // (3) Empty content: good transcript but an all-blank structure -> cv_file extracted, no profile,
  // and a warning (don't send an empty string to the embedder).
  const empty = await ingestCv(db, {
    ...base,
    transcribe: goodTranscribe,
    structure: async () => ({ summary: "", skills: [], targetRoles: [] }),
    embed: stubEmbed,
  });
  console.log("[empty-content]   ", empty);
  assert(empty.status === "extracted", "empty content -> cv_file still extracted");
  assert(empty.profileId === undefined, "empty content -> no profile written");
  assert(
    empty.warnings.some((w) => w.includes("no embeddable content")),
    "empty content -> warned, not embedded",
  );

  console.log(
    "\nPASS: ingestCv happy / failed-transcript / empty-content paths verified with stub seams.",
  );
}

await runScript("test-ingest", main);
