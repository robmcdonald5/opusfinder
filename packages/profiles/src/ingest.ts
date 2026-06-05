import type { Db } from "@opusfinder/db";
import {
  insertCvFile,
  markCvFileFailed,
  patchCvFileExtracted,
  upsertUserProfile,
} from "@opusfinder/db/repos";
import {
  composeProfileText,
  MIN_TRANSCRIPT_CHARS,
  profileWarnings,
  scrubProfilePii,
  type UserId,
} from "@opusfinder/shared";
import type { StorageClient } from "@opusfinder/storage";
import { originalKey, textKey } from "@opusfinder/storage/keys";

import { embedQuery } from "./embed";
import type { ProfileEmbedFn, StructureFn, TranscribeFn } from "./types";

export interface IngestCvOptions {
  userId: UserId;
  /** The PDF bytes. The script reads them from a file; a Phase-12 route passes the upload buffer. */
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  transcribe: TranscribeFn;
  structure: StructureFn;
  embed: ProfileEmbedFn;
  storage: StorageClient;
}

export interface IngestCvResult {
  fileId: number;
  /** The cv_file's terminal status: `extracted` once the transcript is cached, else `failed`. */
  status: "extracted" | "failed";
  /** Set when a profile was embedded + upserted. */
  profileId?: number;
  embedTokens: number;
  /** Non-fatal flags (e.g. empty skills) for the caller to surface. */
  warnings: string[];
}

/**
 * Ingest a CV: store the original PDF, transcribe → cache the text, structure → scrub → embed →
 * upsert the profile. Argv-free and fully injected (db + transcribe/structure/embed/storage), so it
 * is Worker-portable and unit-testable. ①→②→③ per the Phase-9 plan.
 *
 * The cv_file row is inserted FIRST with a provisional `failed` status, so a failure before the
 * transcript is cached leaves a row that reads as not-extracted (and carries an error sample). Once
 * the transcript is stored the row flips to `extracted`; a later failure (structure/embed) leaves it
 * `extracted` (the 9b guard won't regress it) and re-throws — the cached text stands, only the
 * profile write failed.
 */
export async function ingestCv(db: Db, opts: IngestCvOptions): Promise<IngestCvResult> {
  const { userId, bytes, filename, contentType, transcribe, structure, embed, storage } = opts;

  // R2 keys use a generated uploadId, not the serial cv_file id — so the original can be stored
  // without first round-tripping the insert to learn its PK. The full keys are persisted on the row.
  const uploadId = crypto.randomUUID();
  const r2Original = originalKey(userId, uploadId);
  const r2Text = textKey(userId, uploadId);

  const { id: fileId } = await insertCvFile(db, {
    userId,
    r2OriginalKey: r2Original,
    filename,
    contentType,
    byteSize: bytes.byteLength,
  });

  try {
    await storage.putObject({ key: r2Original, body: bytes, contentType });

    const text = await transcribe(bytes);
    if (text.trim().length < MIN_TRANSCRIPT_CHARS) {
      await markCvFileFailed(
        db,
        fileId,
        userId,
        `transcription returned too little text (${text.trim().length} chars)`,
      );
      return {
        fileId,
        status: "failed",
        embedTokens: 0,
        warnings: ["transcript too short — corrupt, encrypted, or image-only PDF?"],
      };
    }

    await storage.putObject({ key: r2Text, body: text, contentType: "text/plain; charset=utf-8" });
    await patchCvFileExtracted(db, fileId, userId, r2Text);

    // Scrub PII in the pipeline (structure() returns RAW extraction) so the no-PII rule is a
    // structural guarantee, not a seam contract — before anything is stored or embedded.
    const structured = scrubProfilePii(await structure(text));
    const warnings = profileWarnings(structured);
    const embedText = composeProfileText(structured);
    if (embedText.length === 0) {
      // Extraction succeeded (text cached) but the profile has no embeddable content — don't send an
      // empty string to the embedder (Voyage rejects it). Leave the file `extracted`, write no profile.
      // (restructure can still reach the cached transcript: getProfileTextKey reads cv_files directly.)
      return {
        fileId,
        status: "extracted",
        embedTokens: 0,
        warnings: [...warnings, "profile had no embeddable content — not embedded"],
      };
    }

    const { vector, usage } = await embedQuery(embed, embedText);

    const { id: profileId } = await upsertUserProfile(db, {
      userId,
      structured,
      embedding: vector,
      sourceCvFileId: fileId,
    });
    return { fileId, profileId, status: "extracted", embedTokens: usage.totalTokens, warnings };
  } catch (err) {
    // Record a secret-free error sample (markCvFileFailed truncates + strips NUL) and leave the row
    // `failed` — unless it already flipped to `extracted` (the 9b guard won't regress it). Best-effort:
    // a failing mark must NEVER mask the real cause, so swallow its error and always re-throw `err`.
    try {
      await markCvFileFailed(db, fileId, userId, err instanceof Error ? err.message : String(err));
    } catch {
      // ignore — the original error (re-thrown below) is what matters.
    }
    throw err;
  }
}
