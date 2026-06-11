import { composeProfileText, type StructuredProfile } from "@opusfinder/shared";

/**
 * The Phase-10 digest SYNTHESIS prompt — one short "why this matches you" note per ranked job. Run via
 * the Message Batches API (Sonnet 4.6, 50% discount) one request per kept item; the system (rubric +
 * profile) is the cached prefix shared across a user's items, the per-job text is the variable tail
 * ({@link renderDigestJob}). Synthesis writes the REASON only — it must NOT re-rank (order comes from
 * the rerank step). Output is plain text (no structured schema), so it avoids any
 * structured-output-in-batch dependency.
 */
export const DIGEST_SYNTHESIS_SYSTEM = `You write a single short note explaining why one job posting is a good match for a specific candidate, for inclusion in their personalized job digest.

You are given the candidate's profile (summary, skills, target roles) in the system context, and ONE job posting (title + description) in the user message.

Write the match note:
- 1–2 sentences, addressed to the candidate in the second person ("You…", "Your…").
- Ground it ONLY in the provided candidate profile and job posting. Name the specific overlap that makes this a fit — the skills, target role, seniority, or domain they share. Do NOT invent skills, experience, requirements, or facts not present in the text.
- Be specific, not generic. "This matches your interest in distributed systems and your Go experience" — not "This looks like a great opportunity for you."
- Do NOT restate the whole job or list its requirements. Do NOT mention salary, location, or how to apply (the digest shows those separately). Do NOT use the company's marketing language.
- If the fit is weak or you cannot find a concrete, grounded overlap, say so plainly in one sentence rather than overselling.

Output ONLY the note text — no preamble, no heading, no quotation marks, no markdown.`;

/**
 * Compose the cached synthesis `system`: the rubric, then the candidate's profile via the shared
 * {@link composeProfileText} (the same representation retrieval + rerank used). The job is NOT here —
 * it's the per-request variable tail ({@link renderDigestJob}). NOTE: at Sonnet 4.6's 2048-token cache
 * minimum a thin rubric+profile may not engage caching (synthesis caching is best-effort regardless);
 * the 50% batch discount is the load-bearing saving, not the cache.
 */
export function buildDigestSystem(profile: StructuredProfile): string {
  return `${DIGEST_SYNTHESIS_SYSTEM}\n\n=== Candidate profile ===\n${composeProfileText(profile)}`;
}

/** Render one job into the synthesis user message. Description truncated (the note needs the gist, not
 *  the full JD). */
export function renderDigestJob(
  job: { title: string; descriptionText: string },
  opts: { descriptionChars?: number } = {},
): string {
  const max = opts.descriptionChars ?? 2000;
  const desc =
    job.descriptionText.length > max ? `${job.descriptionText.slice(0, max)}…` : job.descriptionText;
  return `Write the match note for this job.\n\nTitle: ${job.title}\n\nDescription:\n${desc}`;
}
