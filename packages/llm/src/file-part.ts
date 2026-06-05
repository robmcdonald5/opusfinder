import type { FilePart } from "ai";

/**
 * Build a PDF document part for a vision/transcription call. The AI SDK's `FilePart` with
 * `mediaType: "application/pdf"` is mapped by the @ai-sdk/anthropic provider to an Anthropic document
 * block, so Claude reads the PDF natively (Haiku 4.5 supports PDF input). `data` is the raw bytes.
 */
export function pdfPart(bytes: Uint8Array): FilePart {
  return { type: "file", data: bytes, mediaType: "application/pdf" };
}
