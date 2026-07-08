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
 * The real (Node-only) wiring of the pipeline seams, shared by the two CLI scripts so they agree on how
 * transcribe / structure / embed are built. This is the layer that pulls @opusfinder/llm +
 * @opusfinder/embeddings (and thus their env modules) — keeping it in scripts/ is what lets
 * packages/profiles/src stay Worker-portable. Both LLM calls run at temperature 0: transcription is a
 * faithful-copy task and structuring is grounded extraction, so determinism beats creativity.
 */

/** Layer 1: Haiku vision over the PDF document block → clean text. */
export const transcribe: TranscribeFn = async (pdf) => {
  const { text, finishReason } = await generate({
    model: "haiku",
    system: CV_TRANSCRIBE_SYSTEM,
    temperature: 0,
    maxOutputTokens: 8192,
    messages: [
      {
        role: "user",
        content: [pdfPart(pdf), { type: "text", text: "Transcribe this CV to clean plain text per the rules." }],
      },
    ],
  });
  // Unlike generateObject (which throws on truncation), generate() returns truncated text SILENTLY
  // with finishReason "length". Fail loudly rather than cache + embed a partial CV — the truncation
  // would be permanent (the cached transcript is what restructure re-reads, never re-transcribing).
  if (finishReason === "length") {
    throw new Error(
      "transcribe: CV transcription hit the maxOutputTokens cap and was truncated. Raise the limit in scripts/seams.ts or split the document.",
    );
  }
  return text;
};

/** Layer 2: Haiku structured extraction → a RAW StructuredProfile (the pipeline scrubs PII). */
export const structure: StructureFn = async (text) => {
  const { object } = await generateObject({
    model: "haiku",
    schema: CvProfileSchema,
    system: CV_STRUCTURE_SYSTEM,
    temperature: 0,
    // Above generateObject's 2048 default, to match the transcribe headroom — a skill-dense CV's
    // profile JSON can exceed 2048 output tokens (which would throw a truncation Error).
    maxOutputTokens: 4096,
    messages: [{ role: "user", content: text }],
  });
  return object;
};

/** Voyage embed, typed to the pipeline seam (structurally identical; reads VOYAGE_API_KEY from env). */
export const embed: ProfileEmbedFn = voyageEmbed;
