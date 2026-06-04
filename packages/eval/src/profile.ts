import { composeProfileText } from "@opusfinder/shared";

import type { EvalProfile } from "./types";

/**
 * Compose the text embedded for a profile — the "query" side of retrieval. Thin eval-side
 * wrapper over `composeProfileText` (@opusfinder/shared), the single source of truth for the
 * profile vector (Phase 9), so the harness embeds profiles exactly the way production ingest does.
 * `EvalProfile extends StructuredProfile`, so `profile` is passed straight through;
 * `composeProfileText` reads only the `{ summary, skills, targetRoles }` subset and ignores the
 * eval-only `id` / `preferences`.
 */
export function profileEmbeddingText(profile: EvalProfile): string {
  return composeProfileText(profile);
}
