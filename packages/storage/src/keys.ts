import type { UserId } from "@opusfinder/shared";

/**
 * R2 object-key helpers — the single definition of where CV artifacts live, so the pipeline and any
 * later admin/cleanup tooling agree on the layout. Keyed by user, then file id. `userId` is the
 * branded {@link UserId} (not a raw string), so the brand's guarantee carries to the key boundary.
 * NOTE: readers should use the key persisted on `user_cv_files` (r2_original_key / r2_text_key), not
 * re-derive via these helpers — so a future layout change here can't orphan already-written objects.
 */

/** The durable original PDF: `originals/{userId}/{fileId}.pdf`. */
export function originalKey(userId: UserId, fileId: number): string {
  return `originals/${userId}/${fileId}.pdf`;
}

/** The cached transcript: `text/{userId}/{fileId}.txt`. */
export function textKey(userId: UserId, fileId: number): string {
  return `text/${userId}/${fileId}.txt`;
}
