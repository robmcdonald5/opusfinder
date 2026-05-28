import type { EvalProfile } from "./types";

/**
 * Compose the text embedded for a profile — the "query" side of retrieval. Mirrors
 * `jobEmbeddingText` (the "document" side, in @opusfinder/db) so the harness embeds profiles
 * the way the Phase-10 digest pipeline will. The summary carries the most signal; skills and
 * target roles are appended as compact, labeled context. PROVISIONAL alongside `EvalProfile` —
 * Phase 9 may refine exactly what goes into the profile vector.
 */
export function profileEmbeddingText(profile: EvalProfile): string {
  return [
    profile.summary,
    profile.skills.length > 0 ? `Skills: ${profile.skills.join(", ")}` : "",
    profile.targetRoles.length > 0 ? `Target roles: ${profile.targetRoles.join(", ")}` : "",
  ]
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
}
