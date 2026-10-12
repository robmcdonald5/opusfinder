import { readFile } from "node:fs/promises";

import { structureCv, transcribeCv } from "@opusfinder/llm";
import { composeProfileText, MIN_TRANSCRIPT_CHARS, profileWarnings, scrubProfilePii } from "@opusfinder/shared";
import { runScript } from "@opusfinder/shared/script";

import type { EvalProfile } from "../src/types";
import type { LabeledProfileFile } from "./pooling";

/**
 * Generate an `EvalProfile` from a real CV PDF via the SAME cv-extract prompts + quality gates the
 * production pipeline uses (transcribe → structure → PII-scrub). Prints a PII-free, not-yet-labeled
 * label file to stdout: save it as data/profiles/<profile-id>.json, then run build:pool,
 * draft-labels and build:dataset.
 *
 * The LLM calls are the ones packages/profiles wires (transcribeCv/structureCv from @opusfinder/llm);
 * the quality gates below mirror ingestCv's. It is NOT a full ingestCv: it does not persist to R2/DB.
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

  // Layer 1: transcribe (throws on a truncated or refused transcript). Also fail on a too-short one
  // (like ingestCv's MIN_TRANSCRIPT_CHARS gate) — a degraded PDF must not become a hollow profile.
  const transcript = await transcribeCv(bytes);
  if (transcript.trim().length < MIN_TRANSCRIPT_CHARS) {
    throw new Error("transcription returned too little text — corrupt, encrypted, or image-only PDF?");
  }

  // Layer 2: structure → scrub PII (exactly what the production pipeline persists + embeds).
  const profile: EvalProfile = { id, ...scrubProfilePii(await structureCv(transcript)) };

  // Empty-content gate (like ingestCv + the dataset validator) — fail at the source, not later at
  // build:dataset load time.
  if (composeProfileText(profile).length === 0) {
    throw new Error("structured profile has no embeddable content (empty summary, skills, and target roles).");
  }
  // Surface partial extractions the way ingest-cv does, so a weak profile isn't pasted blindly.
  const warnings = profileWarnings(profile);

  // Guidance + any warnings to stderr; the label-file JSON to stdout (so it can be piped/inspected cleanly).
  if (warnings.length > 0) console.error(`// WARNING: ${warnings.join("; ")}`);
  console.error(
    `// cv-extract output — review for residual PII + accuracy, save as data/profiles/${id}.json, ` +
      "then run build:pool, draft-labels, build:dataset.",
  );
  // Empty goodIds AND notes is the "never labeled" marker draft-labels and build:dataset key on.
  const file: LabeledProfileFile = { profile, goodIds: [], notes: "" };
  console.log(JSON.stringify(file, null, 2));
}

await runScript("ExtractProfile", main);
