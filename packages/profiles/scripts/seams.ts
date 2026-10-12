import { embed as voyageEmbed } from "@opusfinder/embeddings";
import { structureCv, transcribeCv } from "@opusfinder/llm";

import type { ProfileEmbedFn, StructureFn, TranscribeFn } from "../src/index";

/**
 * The real (Node-only) wiring of the pipeline seams, shared by the two CLI scripts so they agree on how
 * transcribe / structure / embed are built. This is the layer that pulls @opusfinder/llm +
 * @opusfinder/embeddings (and thus their env modules) — keeping it in scripts/ is what lets
 * packages/profiles/src stay Worker-portable. The LLM calls live in @opusfinder/llm so the eval
 * extractor runs the same ones.
 */

/** Layer 1: Haiku vision over the PDF → clean text (throws unless the model stopped naturally). */
export const transcribe: TranscribeFn = transcribeCv;

/** Layer 2: Haiku structured extraction → a RAW StructuredProfile (the pipeline scrubs PII). */
export const structure: StructureFn = structureCv;

/** Voyage embed, typed to the pipeline seam (structurally identical; reads VOYAGE_API_KEY from env). */
export const embed: ProfileEmbedFn = voyageEmbed;
