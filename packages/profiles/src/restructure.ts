import type { Db } from "@opusfinder/db";
import { getProfileTextKey, upsertUserProfile } from "@opusfinder/db/repos";
import { composeProfileText, type UserId } from "@opusfinder/shared";
import type { StorageClient } from "@opusfinder/storage";

import type { ProfileEmbedFn, StructureFn } from "./types";

/**
 * Re-structure a user's profile from the CACHED transcript in R2 (skips the expensive transcribe
 * call), then re-embed + upsert. The re-run seam for a structuring prompt/schema change. Throws if
 * the user has no profile or the transcript object is missing.
 */
export async function restructureProfile(
  db: Db,
  deps: { structure: StructureFn; embed: ProfileEmbedFn; storage: StorageClient },
  userId: UserId,
): Promise<void> {
  const ref = await getProfileTextKey(db, userId);
  if (!ref) throw new Error(`restructureProfile: no cached transcript for user ${userId}`);

  const bytes = await deps.storage.getObject(ref.r2TextKey);
  if (!bytes) throw new Error(`restructureProfile: transcript object missing at ${ref.r2TextKey}`);
  const text = new TextDecoder().decode(bytes);

  const structured = await deps.structure(text);
  const embedText = composeProfileText(structured);
  if (embedText.length === 0) {
    throw new Error("restructureProfile: re-structured profile had no embeddable content");
  }

  const { embeddings } = await deps.embed([embedText], { inputType: "query" });
  const vector = embeddings[0];
  if (!vector) throw new Error("embed() returned no vector");

  await upsertUserProfile(db, {
    userId,
    structured,
    embedding: vector,
    sourceCvFileId: ref.sourceCvFileId,
  });
}
