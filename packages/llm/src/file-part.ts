import type { PdfPart } from "./messages";

/**
 * Build a PDF part for a vision/transcription call. It is sent as an Anthropic document block, so Claude
 * reads the PDF natively. `data` is the raw bytes. Sync calls only (see {@link PdfPart}).
 */
export function pdfPart(bytes: Uint8Array): PdfPart {
  return { type: "pdf", data: bytes };
}
