import type { Db } from "@opusfinder/db";
import { getProfileStructured, writeProfileEmbedding } from "@opusfinder/db/repos";
import { composeProfileText, type UserId } from "@opusfinder/shared";

import type { ProfileEmbedFn } from "./types";

/**
 * Re-embed a user's profile from the STORED structured JSON — no LLM, no storage. The cheapest re-run
 * seam (for an embedding-model swap): it rides on `user_profiles.structured` (already PII-scrubbed at
 * ingest), so it never re-pays transcribe/structure and needs no re-scrub. Throws if the user has no
 * profile, or if the stored profile somehow composes to empty (an embedder rejects an empty input).
 */
export async function reembedProfile(db: Db, embed: ProfileEmbedFn, userId: UserId): Promise<void> {
  const structured = await getProfileStructured(db, userId);
  if (!structured) throw new Error(`reembedProfile: no profile for user ${userId}`);

  const text = composeProfileText(structured);
  if (text.length === 0) {
    throw new Error(`reembedProfile: stored profile for user ${userId} has no embeddable content`);
  }

  const { embeddings } = await embed([text], { inputType: "query" });
  const vector = embeddings[0];
  if (!vector || vector.length === 0) throw new Error("embed() returned no usable vector");
  await writeProfileEmbedding(db, userId, vector);
}
