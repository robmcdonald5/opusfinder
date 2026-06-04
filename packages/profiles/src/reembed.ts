import type { Db } from "@opusfinder/db";
import { getProfileStructured, writeProfileEmbedding } from "@opusfinder/db/repos";
import { composeProfileText, type UserId } from "@opusfinder/shared";

import type { ProfileEmbedFn } from "./types";

/**
 * Re-embed a user's profile from the STORED structured JSON — no LLM, no storage. The cheapest re-run
 * seam (for an embedding-model swap): it rides on `user_profiles.structured`, so it never re-pays
 * transcribe or structure. Throws if the user has no profile.
 */
export async function reembedProfile(db: Db, embed: ProfileEmbedFn, userId: UserId): Promise<void> {
  const structured = await getProfileStructured(db, userId);
  if (!structured) throw new Error(`reembedProfile: no profile for user ${userId}`);
  const { embeddings } = await embed([composeProfileText(structured)], { inputType: "query" });
  const vector = embeddings[0];
  if (!vector) throw new Error("embed() returned no vector");
  await writeProfileEmbedding(db, userId, vector);
}
