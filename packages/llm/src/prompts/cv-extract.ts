import { z } from "zod";

import type { StructuredProfile } from "@opusfinder/shared";

import { pdfPart } from "../file-part";
import { generate } from "../generate";
import { generateObject } from "../generate-object";

/**
 * The two CV-ingestion calls and their prompts, exported so the eval harness runs the SAME calls
 * production does. Layer 1 (transcribe) and Layer 2 (structure) are deliberately separate calls so the
 * structured extraction can re-run from cached text without re-paying the vision call. Both run at low
 * effort: transcription is a faithful-copy task (thinking off, so the cap is all transcript) and
 * structuring is grounded extraction.
 */

/**
 * Layer 1 — transcription. Reads the PDF (vision) and emits clean plain text. Used with `generate()`
 * + `pdfPart()` (not `generateObject`): its job is faithful transcription, not interpretation.
 */
export const CV_TRANSCRIBE_SYSTEM = `You transcribe the career-relevant content of a CV / résumé PDF into clean, plain UTF-8 text.

Rules:
- Output ONLY the transcribed text — no preamble, commentary, or markdown code fences.
- Preserve the meaningful content and its logical reading order: section headings, role titles,
  employers, dates, bullet points, skills, education, projects. For a multi-column layout, follow the
  human reading order within each column rather than reading straight across the columns.
- Transcribe what is actually written. Do NOT invent, summarize, paraphrase, or embellish. If a region
  is unreadable, omit it rather than guessing.
- OMIT page furniture and non-career noise: page numbers, repeated headers/footers, decorative rules,
  "references available on request", and contact details (email, phone, street address, personal
  links) — none of it carries job-matching signal.
- Keep skills / technology lists verbatim. Normalize whitespace; separate sections with a blank line.`;

/**
 * Layer 2 — structuring. Turns the transcribed text into the {@link CvProfileSchema} profile. Used
 * with `generateObject` over the TEXT (so it re-runs cheaply from cached text). It is not cached: a CV is
 * structured once, so a cache write would rarely be read.
 */
export const CV_STRUCTURE_SYSTEM = `You convert the plain text of a CV / résumé into a compact, PII-free semantic profile used for job matching. You are given the CV text; return ONLY the structured fields.

The profile is embedded as a QUERY vector and matched against job postings, so it is tuned for retrieval signal, NOT for reproducing the CV. It has three fields:

summary — a dense, third-person prose summary of the candidate's professional profile (about 3–6 sentences). Lead with seniority and primary discipline (e.g. "Senior backend engineer with ~8 years..."), then core domains, standout skills/technologies, and the scope/impact they operate at. Write for matching: emphasize transferable, role-relevant signal. Do NOT include the person's name, contact details, specific dates, first-person voice, or employer names (unless an employer is itself strong domain signal).

skills — a deduplicated, normalized list of CONCRETE skills, technologies, tools, languages, frameworks, and methodologies the candidate demonstrably has. Prefer canonical names ("PostgreSQL" not "postgres db"), but keep widely-used short forms where those are canonical. Include both hard technical skills and concrete professional competencies (e.g. "distributed systems design", "technical leadership"). EXCLUDE vague soft-skill filler ("hard worker", "team player", "detail-oriented") and anything the CV does not support.

targetRoles — the roles the candidate is a strong fit for, as canonical market role titles (e.g. "Senior Backend Engineer", "Staff Software Engineer", "Engineering Manager"). Infer from their most recent and most senior titles plus trajectory — not just the literal last title. Return 1–5 roles, most-fitting first; prefer standard titles over company-specific ones.

Extraction rules:
- Ground everything in the CV text. Never invent skills, roles, or seniority the content does not support.
- Resolve seniority from titles + years of experience + scope, not title inflation alone.
- For career changers or students with little history, summarize the strongest available signal (education, projects, internships) and target appropriate entry or transition roles.
- Normalize and deduplicate skills; collapse obvious synonyms.
- Drop all PII (name, email, phone, address, links) and all CV formatting — none of it belongs in the profile.
- If the text is too sparse to support a field, return the best-supported minimal value (e.g. an empty skills list rather than guessed skills).`;

/**
 * Layer-2 output schema — the same `{ summary, skills, targetRoles }` shape as `StructuredProfile`
 * (@opusfinder/shared). The CV pipeline types its `structure()` seam as returning `StructuredProfile`,
 * so any drift between this schema and that type fails the pipeline's typecheck.
 */
export const CvProfileSchema = z.object({
  summary: z
    .string()
    .describe("Dense third-person professional summary (~3–6 sentences), PII-free, tuned for job matching."),
  skills: z
    .array(z.string())
    .describe("Deduplicated, normalized concrete skills / technologies / competencies; no soft-skill filler."),
  targetRoles: z
    .array(z.string())
    .describe("Canonical role titles the candidate fits / targets, most-fitting first (1–5)."),
});

/** The structured profile inferred from {@link CvProfileSchema}; matches `StructuredProfile`. */
export type CvProfile = z.infer<typeof CvProfileSchema>;

// Compile-time tripwire: CvProfileSchema must infer EXACTLY StructuredProfile (summary, skills[],
// targetRoles[]). A drift in either fails `pnpm --filter @opusfinder/llm typecheck` NOW, not silently
// when the CV pipeline wires its `structure()` seam (which is typed to return StructuredProfile).
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _cvProfileMatchesStructuredProfile: Equal<CvProfile, StructuredProfile> = true;

/** Layer 1: Haiku vision over the PDF → clean transcript text. */
export async function transcribeCv(pdf: Uint8Array): Promise<string> {
  const { text, stopReason } = await generate({
    model: "haiku",
    system: CV_TRANSCRIBE_SYSTEM,
    effort: "low",
    thinking: "off",
    // Room for a long multi-page CV; a cap, not a spend.
    maxOutputTokens: 16000,
    messages: [
      {
        role: "user",
        content: [
          pdfPart(pdf),
          { type: "text", text: "Transcribe this CV to clean plain text per the rules." },
        ],
      },
    ],
  });
  // generate() returns a cut-off or refused transcript without throwing, and a cached transcript is
  // permanent (restructure re-reads it, never re-transcribing) — so accept only a natural stop.
  if (stopReason !== "end_turn") {
    const hint =
      stopReason === "max_tokens" ? "; raise transcribeCv's maxOutputTokens or split the PDF" : "";
    throw new Error(`transcribeCv: transcription stopped with "${stopReason ?? "none"}"${hint}`);
  }
  return text;
}

/** Layer 2: Haiku structured extraction over the transcript → a RAW profile (callers scrub PII). */
export async function structureCv(text: string): Promise<CvProfile> {
  const { object } = await generateObject({
    model: "haiku",
    schema: CvProfileSchema,
    system: CV_STRUCTURE_SYSTEM,
    effort: "low",
    // Above generateObject's 2048 default: a skill-dense CV's profile JSON plus any thinking can exceed
    // it (which would throw a truncation Error).
    maxOutputTokens: 8192,
    messages: [{ role: "user", content: text }],
  });
  return object;
}
