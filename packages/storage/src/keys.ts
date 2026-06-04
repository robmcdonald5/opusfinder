import type { UserId } from "@opusfinder/shared";

/**
 * R2 object-key helpers — the single definition of where CV artifacts live, so the pipeline and any
 * later admin/cleanup tooling agree on the layout. Keyed by user, then an opaque per-upload id (a
 * UUID minted at ingest, NOT the serial cv_file PK — so the original can be stored before the row is
 * inserted). `userId` is the branded {@link UserId}, so the brand's guarantee carries to the key
 * boundary. NOTE: readers should use the key persisted on `user_cv_files` (r2_original_key /
 * r2_text_key), not re-derive via these helpers — so a future layout change here can't orphan
 * already-written objects.
 */

/** The durable original PDF: `originals/{userId}/{id}.pdf`. */
export function originalKey(userId: UserId, id: string): string {
  return `originals/${userId}/${id}.pdf`;
}

/** The cached transcript: `text/{userId}/{id}.txt`. */
export function textKey(userId: UserId, id: string): string {
  return `text/${userId}/${id}.txt`;
}
