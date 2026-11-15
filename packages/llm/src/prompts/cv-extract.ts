import { z } from "zod";

import { CREDENTIAL_STATUSES, EDUCATION_LEVELS, type StructuredProfile } from "@opusfinder/shared";

import { pdfPart } from "../file-part";
import { generate } from "../generate";
import { generateObject } from "../generate-object";
import type { LlmConfig } from "../openrouter";

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
 * The version of the Layer-2 extraction (prompt + schema), stamped on every profile {@link structureCv}
 * returns. Bump it whenever a change makes old and new profiles differ in shape or meaning, so stored
 * profiles can be told apart and re-extracted from their cached transcripts. Version 1 had no tag.
 */
export const CV_EXTRACT_VERSION = 2;

/**
 * Layer 2 — structuring. Turns the transcribed text into the {@link CvProfileSchema} profile. Used
 * with `generateObject` over the TEXT (so it re-runs cheaply from cached text). It is not cached: a CV is
 * structured once, so a cache write would rarely be read.
 */
export const CV_STRUCTURE_SYSTEM = `You convert the plain text of a CV / résumé into a compact, PII-free profile used for job matching. The people behind these CVs work in every field: nurses and care aides, electricians and mechanics, cooks, cashiers and warehouse staff, drivers, teachers, accountants, civil servants, engineers. You are given the CV text; return ONLY the structured fields.

The profile has two parts. summary, skills and targetRoles are embedded as a QUERY vector and matched against job postings, so they are tuned for retrieval signal, NOT for reproducing the CV. facts records what the CV states about eligibility; it is stored as written and never embedded, so it is tuned for accuracy, not signal.

summary — a dense, third-person prose summary of the candidate's professional profile (about 3–6 sentences). Lead with level and primary occupation in that occupation's own terms (e.g. "Senior backend engineer with ~8 years...", "Registered nurse with 14 years in medical-surgical and geriatric care...", "Line cook with fast-casual and catering experience...", "Journeyman electrician..."), then the settings or domains worked in, standout skills, and the scope they operate at (team led, patient load, volume, budget, territory). Write for matching: emphasize transferable, role-relevant signal. Do NOT include the person's name, contact details, specific dates, first-person voice, or employer names (unless an employer is itself strong domain signal).

skills — a deduplicated, normalized list of CONCRETE skills the candidate demonstrably has: procedures, equipment, tools, systems, technologies, methods and professional competencies. Examples by field — clinical: "wound care", "IV therapy", "medication administration", "Epic"; trades: "conduit bending", "MIG welding", "blueprint reading", "concrete forming"; retail and hospitality: "POS operation", "cash handling", "visual merchandising", "food prep"; logistics: "order picking", "pallet jack operation", "route delivery"; public sector: "case management", "grant administration", "regulatory inspection"; software: "PostgreSQL", "distributed systems design". Prefer canonical names ("PostgreSQL" not "postgres db"), but keep widely-used short forms where those are canonical. A licence or certification belongs in facts.credentials; also list it here when postings ask for it by name ("CDL Class A", "ServSafe", "CCNA"). EXCLUDE vague soft-skill filler ("hard worker", "team player", "detail-oriented") and anything the CV does not support.

targetRoles — the roles the candidate is a strong fit for, as canonical market role titles (e.g. "Registered Nurse", "Charge Nurse", "Certified Nursing Assistant", "Electrician", "Line Cook", "Warehouse Associate", "Retail Store Manager", "Staff Accountant", "Senior Backend Engineer"). Infer from their most recent and most senior titles plus trajectory — not just the literal last title; a role the CV says the candidate is seeking counts too. Return 1–5 roles, most-fitting first; prefer standard titles over company-specific ones.

facts — only what the CV says. Each field stays empty or null when the CV is silent; an empty answer is correct, a guessed one is an error.

facts.credentials — licences, registrations, certifications, cards and clearances that qualify someone to do a kind of work: a nursing or teaching licence, CNA, CPA, bar admission, CDL or a driver's licence, FAA A&P, a journeyman card, ServSafe, a food handler card, CPR / BLS / ACLS, OSHA 10 or 30, a forklift certification, TWIC, a security clearance, PMP, vendor certifications (CCNA, CompTIA A+). One entry per credential.
  - name: the credential in its usual form, with the level, class, state or specialty the CV gives ("Registered Nurse (RN)", "Licensed Vocational Nurse (LVN), California", "CDL Class A", "Secret security clearance"). NEVER the licence or registration number.
  - issuer: the body that granted it, if the CV names one ("American Red Cross", "State of Illinois"); otherwise null.
  - status: "active" if the CV says it is active, current or in good standing; "inactive" if it says expired, lapsed, inactive or previous; "in_progress" if it says the candidate is pursuing it, is an exam candidate or expects it; otherwise null. Do not work the status out from dates.
  - expires: the expiry the CV gives, as "YYYY-MM" or "YYYY"; for a stated validity period, its end. Otherwise null. The date a credential was earned is not an expiry.
  - A credential the CV uses as a designation counts as stated: "RN Staff Nurse", "Jane Doe, CPA", "Certified Pharmacy Technician".
  - NOT credentials: degrees and diplomas (they go in education), courses, trainings, workshops and conferences attended, awards, memberships, and a bare claim of being "trained in" something.

facts.education — one entry per programme the CV lists, including high school when it is listed.
  - level: "high_school" (diploma or GED); "certificate" (vocational, trade, technical or other non-degree programme, including an apprenticeship or academy); "associate"; "bachelor"; "master"; "doctorate" (PhD and professional doctorates such as MD, JD, PharmD, DNP); "other" when the CV does not make the level clear.
  - field: the subject as the CV gives it ("Nursing", "Process Technology"); null if none is given.
  - completed: false if the CV says it is in progress, expected, or attended without finishing; otherwise true.

facts.yearsExperience — only lengths of experience the CV states in words or figures ("25+ years of experience" → 25, "eleven years" → 11, "5 years 7 months" → 5.6). Do not add up or subtract employment dates.
  - total: the stated length of the candidate's working experience overall or in their main occupation; null if the CV gives no such figure.
  - byRoleFamily: stated lengths scoped to one function, specialty or setting, when that scope is narrower than the whole career ("8 years in nursing and 3 in management" → two entries; "6 years of ETL experience" → one). roleFamily is a short label in the CV's words. Empty if none are stated.

facts.languages — human languages the CV lists, each with the proficiency it gives ("native", "fluent", "conversational", "bilingual") or null. Do not add the language the CV is written in unless the CV lists it. Programming languages are skills, not languages.

facts.workAuthorization — the CV's own statement about the right to work or sponsorship, kept close to its wording ("Authorized to work in the US for any employer", "US citizen", "Green card holder", "Work permit, no visa sponsorship required"); null if the CV makes none. A place of birth, a nationality, a country of study or past work, a name or a language is NOT such a statement — never derive one.

Extraction rules:
- Ground everything in the CV text. Never invent skills, roles, seniority, credentials or any other value the content does not support.
- Resolve seniority from titles + stated experience + scope, not title inflation alone.
- For career changers or students with little history, summarize the strongest available signal (education, projects, internships) and target appropriate entry or transition roles.
- Normalize and deduplicate skills; collapse obvious synonyms.
- Drop all PII (name, email, phone, address, links) and all CV formatting — none of it belongs in the profile.
- Never record or infer age, date or place of birth, gender, marital or family status, race, ethnicity, national origin, religion, disability or health, in any field, even when the CV states them.
- If the text is too sparse to support a field, return the best-supported minimal value (e.g. an empty skills list rather than guessed skills).`;

const CvFactsSchema = z.object({
  credentials: z
    .array(
      z.object({
        name: z.string().describe("The credential, without any licence or registration number."),
        issuer: z.string().nullable().describe("The granting body if the CV names it, else null."),
        status: z
          .enum(CREDENTIAL_STATUSES)
          .nullable()
          .describe("Only if the CV states it, else null."),
        expires: z.string().nullable().describe('Stated expiry as "YYYY-MM" or "YYYY", else null.'),
      }),
    )
    .describe("Licences, registrations, certifications, cards and clearances the CV states."),
  education: z
    .array(
      z.object({
        level: z.enum(EDUCATION_LEVELS),
        field: z.string().nullable().describe("Subject as the CV gives it, else null."),
        completed: z
          .boolean()
          .describe("False only if the CV says in progress, expected or unfinished."),
      }),
    )
    .describe("One entry per programme the CV lists."),
  yearsExperience: z
    .object({
      total: z.number().nullable().describe("Stated overall years of experience, else null."),
      byRoleFamily: z
        .array(z.object({ roleFamily: z.string(), years: z.number() }))
        .describe("Stated years scoped to one function, specialty or setting."),
    })
    .describe("Lengths of experience the CV states; never computed from dates."),
  languages: z
    .array(
      z.object({
        language: z.string(),
        proficiency: z.string().nullable().describe("As the CV gives it, else null."),
      }),
    )
    .describe("Human languages the CV lists."),
  workAuthorization: z
    .string()
    .nullable()
    .describe("The CV's own right-to-work or sponsorship statement, else null."),
});

/**
 * Layer-2 output schema: the `{ summary, skills, targetRoles, facts }` of `StructuredProfile`
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
  facts: CvFactsSchema.describe("What the CV states about eligibility. Stored, not embedded."),
});

/** What the model returns; {@link structureCv} adds the version tag to make a `StructuredProfile`. */
export type CvProfile = z.infer<typeof CvProfileSchema>;

// Compile-time tripwire: CvProfileSchema must infer EXACTLY StructuredProfile's extracted fields. A
// drift in either fails `pnpm --filter @opusfinder/llm typecheck` NOW, not silently when the CV
// pipeline wires its `structure()` seam (which is typed to return StructuredProfile).
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _cvProfileMatchesStructuredProfile: Equal<
  CvProfile,
  Required<Omit<StructuredProfile, "extractVersion">>
> = true;

/** Layer 1: Haiku vision over the PDF → clean transcript text. */
export async function transcribeCv(pdf: Uint8Array, config: LlmConfig = {}): Promise<string> {
  const { text, stopReason } = await generate({
    ...config,
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
export async function structureCv(text: string, config: LlmConfig = {}): Promise<StructuredProfile> {
  const { object } = await generateObject({
    ...config,
    model: "haiku",
    schema: CvProfileSchema,
    system: CV_STRUCTURE_SYSTEM,
    effort: "low",
    // Above generateObject's 2048 default: a skill-dense CV's profile JSON plus any thinking can exceed
    // it (which would throw a truncation Error).
    maxOutputTokens: 8192,
    messages: [{ role: "user", content: text }],
  });
  return { ...object, extractVersion: CV_EXTRACT_VERSION };
}
