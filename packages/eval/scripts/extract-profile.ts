import { readFile } from "node:fs/promises";

import {
  CV_STRUCTURE_SYSTEM,
  CV_TRANSCRIBE_SYSTEM,
  CvProfileSchema,
  generate,
  generateObject,
  pdfPart,
} from "@opusfinder/llm";
import { composeProfileText, scrubProfilePii } from "@opusfinder/shared";
import { runScript } from "@opusfinder/shared/script";

import type { EvalProfile } from "../src/types";

/**
 * Generate an `EvalProfile` from a real CV PDF via the SAME cv-extract prompts + quality gates the
 * production pipeline uses (transcribe → structure → PII-scrub), so the Phase-5 eval harness exercises
 * the Phase-9 extraction prompt. Prints a paste-ready, PII-free profile to stdout; the CV owner (the
 * labeling authority) adds `goodIds` for it in build-dataset.ts's LABELS and re-runs build:dataset.
 *
 * The LLM wiring + guards mirror packages/profiles (scripts/seams.ts + ingestCv's gates) — kept
 * separate because those seams are script-local and the @opusfinder/profiles index stays
 * Worker-portable (it can't export the llm-pulling wiring). It is NOT a full ingestCv: it prints a
 * profile, it does not persist to R2/DB.
 *
 *   pnpm --filter @opusfinder/eval extract-profile <cv.pdf> <profile-id>
 */

/** Mirrors ingestCv's transcript floor (a shorter transcript means a corrupt / encrypted / image-only PDF). */
const MIN_TRANSCRIPT_CHARS = 50;

async function main(): Promise<void> {
  const pdfPath = process.argv[2]?.trim();
  const id = process.argv[3]?.trim();
  if (!pdfPath || !id) {
    console.error("Usage: pnpm --filter @opusfinder/eval extract-profile <cv.pdf> <profile-id>");
    process.exitCode = 1;
    return;
  }

  const bytes = await readFile(pdfPath);

  // Layer 1: transcribe. Fail loud on truncation (like the ingest seam) AND on a too-short transcript
  // (like ingestCv's MIN_TRANSCRIPT_CHARS gate) — a degraded PDF must not become a hollow profile.
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
  if (transcript.text.trim().length < MIN_TRANSCRIPT_CHARS) {
    throw new Error("transcription returned too little text — corrupt, encrypted, or image-only PDF?");
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

  // Empty-content gate (like ingestCv + the dataset validator) — fail at the source, not later at
  // build:dataset load time.
  if (composeProfileText(profile).length === 0) {
    throw new Error("structured profile has no embeddable content (empty summary, skills, and target roles).");
  }
  // Surface partial extractions the way ingest-cv does, so a weak profile isn't pasted blindly.
  const warnings: string[] = [];
  if (profile.summary.trim().length === 0) warnings.push("empty summary");
  if (profile.skills.length === 0) warnings.push("no skills extracted");
  if (profile.targetRoles.length === 0) warnings.push("no target roles extracted");

  // Guidance + any warnings to stderr; the profile JSON to stdout (so it can be piped/inspected cleanly).
  if (warnings.length > 0) console.error(`// WARNING: ${warnings.join("; ")}`);
  console.error("// cv-extract output — review for residual PII + accuracy, then add `goodIds` in build-dataset.ts LABELS.");
  console.log(JSON.stringify(profile, null, 2));
}

await runScript("ExtractProfile", main);
