import { readFile } from "node:fs/promises";

import {
  CV_STRUCTURE_SYSTEM,
  CV_TRANSCRIBE_SYSTEM,
  CvProfileSchema,
  generate,
  generateObject,
  pdfPart,
} from "@opusfinder/llm";
import { scrubProfilePii } from "@opusfinder/shared";
import { runScript } from "@opusfinder/shared/script";

import type { EvalProfile } from "../src/types";

/**
 * Generate an `EvalProfile` from a real CV PDF via the SAME cv-extract prompts production uses
 * (transcribe → structure → PII-scrub), so the Phase-5 eval harness exercises the Phase-9 extraction
 * prompt. Prints a paste-ready, PII-free profile to stdout; the CV owner (the labeling authority) adds
 * `goodIds` for it in build-dataset.ts's LABELS and re-runs build:dataset.
 *
 * The LLM wiring mirrors packages/profiles/scripts/seams.ts — kept separate because those seams are
 * script-local and the @opusfinder/profiles index stays Worker-portable (it can't export the
 * llm-pulling wiring).
 *
 *   pnpm --filter @opusfinder/eval extract-profile <cv.pdf> <profile-id>
 */
async function main(): Promise<void> {
  const pdfPath = process.argv[2]?.trim();
  const id = process.argv[3]?.trim();
  if (!pdfPath || !id) {
    console.error("Usage: pnpm --filter @opusfinder/eval extract-profile <cv.pdf> <profile-id>");
    process.exitCode = 1;
    return;
  }

  const bytes = await readFile(pdfPath);

  // Layer 1: transcribe (fail loud on truncation, same as the ingest seam).
  const transcript = await generate({
    model: "haiku",
    system: CV_TRANSCRIBE_SYSTEM,
    temperature: 0,
    maxOutputTokens: 8192,
    messages: [
      {
        role: "user",
        content: [pdfPart(bytes), { type: "text", text: "Transcribe this CV to clean plain text per the rules." }],
      },
    ],
  });
  if (transcript.finishReason === "length") {
    throw new Error("transcription hit the maxOutputTokens cap (truncated). Raise the limit or split the document.");
  }

  // Layer 2: structure → scrub PII (exactly what the production pipeline persists + embeds).
  const { object } = await generateObject({
    model: "haiku",
    schema: CvProfileSchema,
    system: CV_STRUCTURE_SYSTEM,
    temperature: 0,
    maxOutputTokens: 4096,
    messages: [{ role: "user", content: transcript.text }],
  });

  const profile: EvalProfile = { id, ...scrubProfilePii(object) };

  // Guidance to stderr, the profile JSON to stdout (so it can be piped/inspected cleanly).
  console.error("// cv-extract output — review for residual PII + accuracy, then add `goodIds` in build-dataset.ts LABELS.");
  console.log(JSON.stringify(profile, null, 2));
}

await runScript("ExtractProfile", main);
