/**
 * Persistence for CV uploads + semantic profiles (Phase 9). Same functional style as the other
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
import { userCvFiles, userProfiles, type CvFileStatus } from "../schema";
import { NUL, stripNul, VECTOR_CAST, vectorLiteral } from "./sql";

/** Cap on a stored `error_sample` — truncated and NUL-stripped; callers must pass a non-PII message
 * (a CV's contact info IS PII), same discipline as source_runs. */
const MAX_ERROR_SAMPLE = 500;
function truncateError(message: string): string {
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

// NOTE (ownership): patchCvFileExtracted / markCvFileFailed key on the file `id` ALONE. In Phase 9
// that id is generated internally by insertCvFile and threaded through ingestCv — never client-
// supplied — so there is no cross-user exposure. When the Phase-12 HTTP upload route accepts an id
// from a request, it MUST verify the row's user_id before calling these (or grow a userId predicate
// here) to avoid an IDOR.

/** Mark a CV file successfully transcribed: record its R2 text key and flip status to `extracted`. */
export async function patchCvFileExtracted(db: Db, id: number, r2TextKey: string): Promise<void> {
  await db.update(userCvFiles).set({ r2TextKey, status: "extracted" }).where(eq(userCvFiles.id, id));
}

/** Mark a CV file failed (the default state for the provisional row), optionally recording a
 * truncated, non-PII error sample. No profile is written for a failed file. The `status <> 'extracted'`
 * guard means a late/duplicate error path (e.g. 9c's try/catch firing after the transcript was
 * cached) can't regress an already-extracted row — which still holds a valid r2_text_key — to 'failed'. */
export async function markCvFileFailed(db: Db, id: number, errorSample?: string): Promise<void> {
  const set: { status: CvFileStatus; errorSample?: string } = { status: "failed" };
  if (errorSample !== undefined) set.errorSample = truncateError(errorSample);
  await db
    .update(userCvFiles)
    .set(set)
    .where(and(eq(userCvFiles.id, id), ne(userCvFiles.status, "extracted")));
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
