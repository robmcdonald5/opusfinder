/**
 * R2 object-key helpers — the single definition of where CV artifacts live, so the pipeline and any
 * later admin/cleanup tooling agree on the layout. Keyed by user, then file id.
 */

/** The durable original PDF: `originals/{userId}/{fileId}.pdf`. */
export function originalKey(userId: string, fileId: number): string {
  return `originals/${userId}/${fileId}.pdf`;
}

/** The cached transcript: `text/{userId}/{fileId}.txt`. */
export function textKey(userId: string, fileId: number): string {
  return `text/${userId}/${fileId}.txt`;
}
