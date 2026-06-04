import { embed as voyageEmbed } from "@opusfinder/embeddings";
import {
  CV_STRUCTURE_SYSTEM,
  CV_TRANSCRIBE_SYSTEM,
  CvProfileSchema,
  generate,
  generateObject,
  pdfPart,
} from "@opusfinder/llm";

import type { ProfileEmbedFn, StructureFn, TranscribeFn } from "../src/index";

/**
 * The real (Node-only) wiring of the pipeline seams, shared by the three scripts so they agree on how
 * transcribe / structure / embed are built. This is the layer that pulls @opusfinder/llm +
 * @opusfinder/embeddings (and thus their env modules) — keeping it in scripts/ is what lets
 * packages/profiles/src stay Worker-portable.
 */

/** Layer 1: Haiku vision over the PDF document block → clean text. */
export const transcribe: TranscribeFn = async (pdf) => {
  const { text } = await generate({
    model: "haiku",
    system: CV_TRANSCRIBE_SYSTEM,
    maxOutputTokens: 8192,
    messages: [
      {
        role: "user",
        content: [pdfPart(pdf), { type: "text", text: "Transcribe this CV to clean plain text per the rules." }],
      },
    ],
  });
  return text;
};

/** Layer 2: Haiku structured extraction → a RAW StructuredProfile (the pipeline scrubs PII). */
export const structure: StructureFn = async (text) => {
  const { object } = await generateObject({
    model: "haiku",
    schema: CvProfileSchema,
    system: CV_STRUCTURE_SYSTEM,
    messages: [{ role: "user", content: text }],
  });
  return object;
};

/** Voyage embed, typed to the pipeline seam (structurally identical; reads VOYAGE_API_KEY from env). */
export const embed: ProfileEmbedFn = voyageEmbed;
