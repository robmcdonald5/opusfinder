/**
 * Persistence for CV uploads + semantic profiles. Same functional style as the other
 * repos: the Drizzle client is injected, no module-level singleton.
 *
 * `user_cv_files` is append-only upload history; `user_profiles` is upserted one row per user
 * (latest CV wins — no content change-guard, unlike `upsertJobs`, because a re-ingest is always an
 * intentional refresh). Vectors are written via the shared pgvector literal + cast (see ./sql),
 * the same way the jobs embeddings are written.
 */
import { and, desc, eq, ne, sql } from "drizzle-orm";

import type { StructuredProfile, UserId } from "@opusfinder/shared";

import type { Db } from "../client";
import { user, userCvFiles, userProfiles, type CvFileStatus } from "../schema";
import { NUL, stripNul, VECTOR_CAST, vectorLiteral } from "./sql";

/** Cap on a stored `error_sample` — truncated and NUL-stripped; callers must pass a non-PII message
 * (a CV's contact info IS PII), same discipline as source_runs. */
const MAX_ERROR_SAMPLE = 500;
function sanitizeErrorSample(message: string): string {
  return message.replaceAll(NUL, "").slice(0, MAX_ERROR_SAMPLE);
}

/** A new CV upload, before transcription. `insertCvFile` stores it with a provisional `failed`
 * status (so a crash mid-ingest leaves a row that correctly reads as not-extracted). */
export interface NewCvFile {
  userId: UserId;
  r2OriginalKey: string;
  filename: string;
  contentType: string;
  byteSize: number;
}

/** Insert a CV-upload row (status provisionally `failed`) and return its id. */
export async function insertCvFile(db: Db, file: NewCvFile): Promise<{ id: number }> {
  const rows = await db
    .insert(userCvFiles)
    .values({
      userId: file.userId,
      r2OriginalKey: file.r2OriginalKey.replaceAll(NUL, ""),
      filename: file.filename.replaceAll(NUL, ""),
      contentType: file.contentType.replaceAll(NUL, ""),
      byteSize: file.byteSize,
      // status defaults to 'failed' (provisional) — flipped to 'extracted' by patchCvFileExtracted.
    })
    .returning({ id: userCvFiles.id });
  const row = rows[0];
  if (!row) throw new Error("insertCvFile returned no row");
  return row;
}

// NOTE (ownership): patchCvFileExtracted / markCvFileFailed take the owning `userId` and scope their
// UPDATE to `id AND user_id` — defense-in-depth so an HTTP route that accepts a request-supplied id
// can't mutate another user's row. This predicate is NECESSARY but not sufficient on its own: real
// authorization still requires the `userId` to come from the session, not the request.

/** Mark a CV file successfully transcribed: record its R2 text key and flip status to `extracted`. */
export async function patchCvFileExtracted(
  db: Db,
  id: number,
  userId: UserId,
  r2TextKey: string,
): Promise<void> {
  await db
    .update(userCvFiles)
    .set({ r2TextKey, status: "extracted" })
    .where(and(eq(userCvFiles.id, id), eq(userCvFiles.userId, userId)));
}

/** Mark a CV file failed (the default state for the provisional row), optionally recording a
 * truncated, non-PII error sample. No profile is written for a failed file. The `status <> 'extracted'`
 * guard means a late/duplicate error path (firing after the transcript was cached) can't regress an
 * already-extracted row — which still holds a valid r2_text_key — to 'failed'. */
export async function markCvFileFailed(
  db: Db,
  id: number,
  userId: UserId,
  errorSample?: string,
): Promise<void> {
  const set: { status: CvFileStatus; errorSample?: string } = { status: "failed" };
  if (errorSample !== undefined) set.errorSample = sanitizeErrorSample(errorSample);
  await db
    .update(userCvFiles)
    .set(set)
    .where(
      and(
        eq(userCvFiles.id, id),
        eq(userCvFiles.userId, userId),
        ne(userCvFiles.status, "extracted"),
      ),
    );
}

export interface UpsertUserProfileInput {
  userId: UserId;
  structured: StructuredProfile;
  embedding: number[];
  sourceCvFileId: number;
}

/**
 * Upsert the user's profile (one row per `user_id`), latest CV wins. Writes the structured JSON, the
 * embedding vector, and the backing file id; bumps `updated_at`. The embedding is bound as the
 * pgvector text literal cast to `::vector(N)` (same form as the jobs embeddings).
 */
export async function upsertUserProfile(
  db: Db,
  input: UpsertUserProfileInput,
): Promise<{ id: number }> {
  const rows = await db
    .insert(userProfiles)
    .values({
      userId: input.userId,
      structured: stripNul(input.structured) as StructuredProfile,
      embedding: sql`${vectorLiteral(input.embedding)}${VECTOR_CAST}`,
      sourceCvFileId: input.sourceCvFileId,
    })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      // No change-guard: a re-ingest always refreshes structured + embedding + the backing file.
      set: {
        structured: sql`excluded.structured`,
        embedding: sql`excluded.embedding`,
        sourceCvFileId: sql`excluded.source_cv_file_id`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: userProfiles.id });
  const row = rows[0];
  if (!row) throw new Error(`upsertUserProfile returned no row for ${input.userId}`);
  return row;
}

/** The latest extracted upload's file id + cached R2 text key for a user, or null if none — read by
 * the `profiles:restructure` seam (re-structure from cached text, skip transcribe). Queried off
 * `user_cv_files` directly, so it does NOT require a `user_profiles` row. */
export interface ProfileTextRef {
  sourceCvFileId: number;
  r2TextKey: string;
}
export async function getProfileTextKey(db: Db, userId: UserId): Promise<ProfileTextRef | null> {
  // The user's LATEST successfully-extracted upload — queried straight off user_cv_files (not via the
  // profile), so an all-blank structuring that left an extracted file with NO user_profiles row is
  // still reachable by restructure (its cached transcript is the whole point of the re-run seam).
  const rows = await db
    .select({ sourceCvFileId: userCvFiles.id, r2TextKey: userCvFiles.r2TextKey })
    .from(userCvFiles)
    .where(and(eq(userCvFiles.userId, userId), eq(userCvFiles.status, "extracted")))
    .orderBy(desc(userCvFiles.id))
    .limit(1);
  const row = rows[0];
  if (!row || row.r2TextKey === null) return null;
  return { sourceCvFileId: row.sourceCvFileId, r2TextKey: row.r2TextKey };
}

/**
 * The user's semantic profile for the Phase-10 digest: the structured fields, the stored query-side
 * embedding, and the backing file id — read from the one `user_profiles` row (null if the user has
 * none, e.g. no CV ingested yet). The embedding may be null (a profile written when the CV had no
 * embeddable content); the digest caller skips such users. Drizzle's typed `vector` column maps the
 * stored value back to `number[]` on select, so the embedding is ready to pass to
 * `retrieveCandidatesForProfile` (which re-asserts the dimension via `vectorLiteral`).
 */
export interface ProfileForDigest {
  structured: StructuredProfile;
  embedding: number[] | null;
  sourceCvFileId: number;
  /** `user.email_verified` — checked at GENERATION time too (not just the Phase-11 send gate), so a
   *  manual single-user trigger can't spend tokens on, or pollute the shown-history of, an unverified
   *  user the `--all` sweep (listDigestRecipients) would skip. */
  emailVerified: boolean;
}
export async function getProfileForDigest(db: Db, userId: UserId): Promise<ProfileForDigest | null> {
  const rows = await db
    .select({
      structured: userProfiles.structured,
      embedding: userProfiles.embedding,
      sourceCvFileId: userProfiles.sourceCvFileId,
      emailVerified: user.emailVerified,
    })
    .from(userProfiles)
    .innerJoin(user, eq(user.id, userProfiles.userId))
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    structured: row.structured,
    embedding: row.embedding,
    sourceCvFileId: row.sourceCvFileId,
    emailVerified: row.emailVerified,
  };
}
