import { z } from "zod";

import type { StructuredProfile } from "@opusfinder/shared";

/**
 * The two prompts for Phase 9 CV ingestion, exported so the eval harness (Phase 5) runs the SAME
 * prompts production does. Layer 1 (transcribe) and Layer 2 (structure) are deliberately separate
 * calls so the structured extraction can re-run from cached text without re-paying the vision call.
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
 * with `generateObject` over the TEXT (so it re-runs cheaply from cached text). `cacheSystem` may be
 * enabled by the caller; it only engages if this prompt clears the model's minimum cacheable prefix
 * (Haiku ~4096 tokens) — this prompt is intentionally sized for quality, not padded to force caching
 * (a longer prompt would cost more per call than the cache saves at typical fleet sizes).
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
 * (@opusfinder/shared). The CV pipeline (9e) types its `structure()` seam as returning
 * `StructuredProfile`, so any drift between this schema and that type fails the pipeline's typecheck.
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
// targetRoles[]). A drift in either fails `pnpm --filter @opusfinder/llm typecheck` NOW — not silently
// until the 9e pipeline wires its `structure()` seam (which is typed to return StructuredProfile).
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _cvProfileMatchesStructuredProfile: Equal<CvProfile, StructuredProfile> = true;

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// A phone-like run: optional + and (, then digits/separators. Redacted ONLY when it contains >=10
// digits, so it never eats a year range like "2015-2019" (8 digits) or a metric like "p99".
const PHONE_CANDIDATE_RE = /\+?\(?\d[\d\s().-]{8,}\d/g;

function scrubText(text: string): string {
  const noEmail = text.replace(EMAIL_RE, "[redacted]");
  const noPhone = noEmail.replace(PHONE_CANDIDATE_RE, (m) =>
    (m.match(/\d/g)?.length ?? 0) >= 10 ? "[redacted]" : m,
  );
  return noPhone.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Defense-in-depth PII scrub for a structured profile, applied before it is stored + embedded. The
 * prompts already instruct the model to omit PII, but LLM instructions are not a hard guarantee on
 * untrusted CV text and the profile is persisted + vectorized — so redact the machine-detectable PII
 * (email addresses and phone-number runs of >=10 digits). Names are not regex-detectable and stay a
 * prompt-only concern.
 */
export function scrubProfilePii(profile: StructuredProfile): StructuredProfile {
  return {
    summary: scrubText(profile.summary),
    skills: profile.skills.map(scrubText).filter((s) => s.length > 0),
    targetRoles: profile.targetRoles.map(scrubText).filter((s) => s.length > 0),
  };
}
