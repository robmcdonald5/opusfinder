import type { StructuredProfile } from "@opusfinder/shared";

/**
 * The pipeline's injected seams. Keeping these as parameters (rather than importing the concrete
 * libraries) is what keeps `packages/profiles/src` Worker-portable: it never pulls @opusfinder/llm
 * (whose env module loads `node:`/dotenv), @opusfinder/embeddings, or the @opusfinder/storage S3
 * client (which pulls @aws-sdk) into its graph. The Node script (scripts/) wires the real impls.
 */

/** Layer 1: transcribe a PDF's bytes to clean text. The impl pulls @opusfinder/llm (vision call). */
export type TranscribeFn = (pdf: Uint8Array) => Promise<string>;

/**
 * Layer 2: structure transcribed text into a `StructuredProfile` (raw extraction). The pipeline runs
 * the PII scrub itself (`scrubProfilePii` from @opusfinder/shared) before persisting + embedding, so
 * the impl does NOT need to scrub — it just extracts. The impl pulls @opusfinder/llm.
 */
export type StructureFn = (text: string) => Promise<StructuredProfile>;

/**
 * Embed query texts. Mirrors @opusfinder/embeddings' `embed()` return shape, so the real `embed`
 * passes by structural subtyping with no adapter (its extra `model` field is compatible). The impl
 * pulls @opusfinder/embeddings.
 */
export type ProfileEmbedFn = (
  texts: string[],
  params: { inputType: "query" | "document" | null },
) => Promise<{ embeddings: number[][]; usage: { totalTokens: number } }>;
