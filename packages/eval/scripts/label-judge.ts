/**
 * The judgment seam for pooled labeling: what "relevant" MEANS for this dataset (the rubric) plus
 * the one-candidate call that drafts a verdict. Split from draft-labels.ts (which owns
 * orchestration, writing, and the review sheet) so the contract the owner ratifies is ONE readable
 * file of prose — reviewable before reading the verdicts drafted from it.
 *
 * DELIBERATELY NOT @opusfinder/rerank's RERANK_RUBRIC, for two reasons:
 *  - Different task. That rubric ORDERS a digest: a calibrated 0.0–1.0 score over a list. A label is
 *    GROUND TRUTH — a per-job, list-independent "would this candidate genuinely want to see this?".
 *    Thresholding a digest score into a boolean would bake the ranker's own calibration into the
 *    truth that ranker is later scored against.
 *  - Circularity. Manufacturing a ranker's ground truth from that ranker's own prompt makes the eval
 *    partly self-graded. The bite is LATENT today — eval's llm-rerank ranker runs a DETERMINISTIC
 *    STUB (src/rankers/llm-rerank.ts), so no Claude ranker is currently scored against these
 *    Claude-drafted labels — but `llmRerankRanker(realCall)` exists to be wired and these labels
 *    outlive that change. The owner being the labeling authority is the real mitigation; keeping the
 *    judge's prompt independent of the ranker's is the cheap one.
 *
 * CROSS-FUNCTIONAL ON PURPOSE. These profiles come from a 24-category CV dataset (HR, finance,
 * healthcare, skilled trades, sales, media, design...) and the corpus carries matching non-software
 * roles, so this rubric must not inherit the production rubric's software-role-family framing.
 */
import { z } from "zod";

import { generateObject, type ModelAlias } from "@opusfinder/llm";
import { composeProfileText } from "@opusfinder/shared";

import type { EvalProfile } from "../src/types";
import type { PoolCandidate } from "./pooling";

export const VERDICTS = ["good", "borderline", "bad"] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * THREE-way, though the dataset label is binary (`expectedGoodIds`). `borderline` exists so the
 * judge's uncertainty is EXPLICIT rather than silently binarized into a good/bad it did not mean:
 * only `good` becomes a label, and the review sheet points the owner at the borderlines first,
 * which is where their (expensive) attention actually changes the ground truth.
 */
export const LabelVerdictSchema = z.object({
  verdict: z
    .enum(VERDICTS)
    .describe(
      "good = a genuinely useful match worth surfacing; borderline = honest uncertainty or a " +
        "partial match; bad = not a match this candidate would want.",
    ),
  reason: z
    .string()
    .min(1)
    .describe("One sentence naming the DECIDING factor for the verdict. Under ~30 words."),
});
export type LabelVerdict = z.infer<typeof LabelVerdictSchema>;

/**
 * The stable rubric prefix. The candidate profile is appended by {@link buildJudgeSystem}; the job
 * is the per-call user message, so this prefix is identical across every candidate in a profile's
 * pool (see the caching note there).
 */
export const LABEL_JUDGE_RUBRIC = `You are labeling GROUND TRUTH for a job-matching evaluation set. You are shown ONE candidate's anonymized profile and ONE job posting, and you decide whether that posting is a genuinely good match for that candidate. A human reviewer checks your verdicts afterward, so be accurate and decisive rather than agreeable — a wrong label silently corrupts every future measurement made against this dataset.

THE QUESTION TO ANSWER
If this candidate opened a personalized job digest tomorrow and saw this posting, would it be a genuinely useful result — a role they would plausibly click, take seriously, and consider applying to? Judge the ROLE against the PERSON. Not "is this posting related to their field", but "would they want it".

THE CANDIDATE
The profile is a semantic profile tuned for matching: a prose summary, concrete skills, and the roles they are targeting. It deliberately omits name, employers, schools, and contact details — do not expect them and do not treat their absence as a gap. Candidates in this set come from MANY fields — healthcare, human resources, finance and accounting, sales and business development, marketing and public relations, skilled trades and industrial maintenance, consulting, design, information technology, engineering. Never assume a software or technology context unless the profile itself says so.

VERDICTS — return exactly one
- "good" — A genuinely useful match. The role's core function is work this candidate does or explicitly targets, and the skills the role is built on are skills they demonstrably have. They could apply today as a credible applicant. A ONE-STEP difference in level or track does not by itself disqualify a role whose function and core skills line up strongly (see signal 3); when the only reservation is a single step of seniority, prefer "good" over "borderline". This is the label; be willing to give it, but require that the functional fit be real.
- "borderline" — An honest "maybe". Use this when the fit is genuinely partial or genuinely uncertain: an adjacent function that shares real skills but changes focus; a two-step level gap the rest of the profile only partly offsets; a description too sparse to confirm the match a promising title suggests; a stated requirement the profile leaves genuinely unresolved. Use it for real uncertainty — not to avoid deciding a case that is clear once you have worked out what the role actually is, and not merely because the level is one step off.
- "bad" — Not a match. A different occupational field, a level mismatch by a wide margin, or a role built on core requirements this candidate plainly does not have. Most postings you see will be this.

EXPECT A LOW BASE RATE OF "good". The pool you are labeling from was built to be broad on purpose: it mixes semantically-retrieved jobs with keyword matches and a RANDOM sample of the corpus. A large share of what you see is therefore unrelated to the candidate by construction. Do not inflate verdicts to seem useful, and do not assume a posting must be at least borderline because someone put it in front of you.

HOW TO WEIGH SIGNALS (most to least important)
1. Occupational function. Is this the kind of work the candidate does or targets? A registered nurse and a nursing-home administrator share a domain and are still different jobs; an HR business partner and a recruiter are adjacent, not the same; a maintenance technician and a manufacturing engineer overlap in setting but not in role. Function mismatch is the most common reason a superficially-similar posting is "bad".
2. Core skills overlap. Compare what the role is BUILT ON — its required tools, systems, certifications, methods, and competencies — against the candidate's skills. Weight by centrality: a missing "nice to have" barely matters, a missing core requirement caps the verdict at bad. Credit genuinely transferable skills (a comparable system, an equivalent certification, the same craft in a different industry) a notch below exact matches. Credit depth in what the role is about over a long tail of incidental keyword overlap.
3. Seniority and scope. Infer the role's level from its title and language (years required, scope, budget or headcount ownership, "lead", "supervise", "direct", "set strategy") and compare with the candidate's level from their summary (years, scope, whether they manage people or budgets). A ONE-STEP gap does not prevent a "good" verdict when the function and core skills align strongly: an experienced practitioner is a credible applicant for the senior hands-on version of their own craft, and a strong senior practitioner is credible for a first-line lead role in it. This holds ACROSS the contributor/management track too — a hands-on senior role for a first-line manager of that same function, or a team-lead role for a deep senior practitioner, is a one-step move, not a disqualification. A TWO-OR-MORE-step gap is bad in EITHER direction: an experienced manager pointed at an entry-level role is as poor a match as a junior pointed at a director role, and a role leading an organization of managers is not a fit for someone who has never led. Judge the gap by actual scope and responsibility, not by whether the title happens to contain "Manager" or "Engineer".
4. Domain or industry, when the role is DEFINED by it. Usually secondary — but when a posting's value is domain-specific (clinical licensure, a regulated specialty, a specific trade certification, a niche industry's rules), treat that domain as a near-core requirement rather than a tiebreaker.

RULES (must follow)
- Judge ONLY from the profile and the job text given. Never invent skills, credentials, requirements, or seniority the text does not support.
- UNSTATED IS UNKNOWN, NOT NEGATIVE. A short profile omitting a skill is not proof the candidate lacks it; a posting that never mentions a requirement does not have one. Judge on what is present, conservatively — but do not manufacture a match out of silence either.
- Judge this posting ALONE. You are not comparing it to other postings and not filling a quota; there is no target number of good matches.
- IGNORE location, remote/on-site, company prestige, company size, and salary entirely. Those are filtered or presented separately. A prestigious employer is not a better match; an obscure one is not worse.
- Do not reward keyword co-occurrence. A term appearing somewhere in a long description is far weaker evidence than the role being ABOUT that term. Long postings mention more things; that is not fit.
- A shared seniority word ("Senior", "Lead", "Manager") or a shared generic noun ("Specialist", "Analyst", "Engineer", "Coordinator") is not a match on its own. Look past the title to the function and the work.
- Sparse descriptions: judge conservatively from the title and whatever is given. A bare title that clearly matches the candidate's function can still be good; a bare or ambiguous title should not climb above borderline on hope.
- Career changers: weight stated target roles and current skills over older history — judge where they are going. But a target role their skills do not support is still not a good match; intent alone does not make fit.
- Treat company boilerplate, benefits, and EEO statements as noise carrying no matching signal.
- You may see near-duplicate postings from different employers. Judge each on its own merits; identical reasoning producing identical verdicts is correct, not a mistake.

THE REASON FIELD
One sentence naming the DECIDING factor — the specific thing that made this good, borderline, or bad. "Role centers on clinical case management, which the candidate has done for 8 years" is useful. "Good match for their skills" is not. A human reads these to decide whether to trust or overturn your verdict, so make the basis checkable.`;

/**
 * The per-profile system string: the stable rubric, then the candidate via the shared
 * {@link composeProfileText} — the SAME text the profile embedding is built from, so the judge
 * reasons over the representation retrieval used, exactly as the production reranker does.
 *
 * The JOB is deliberately not here: it is the per-call user message, so this prefix stays identical
 * across a profile's whole pool and a caching call can reuse it.
 */
export function buildJudgeSystem(profile: EvalProfile): string {
  return `${LABEL_JUDGE_RUBRIC}\n\n=== Candidate profile ===\n${composeProfileText(profile)}`;
}

/** The job as the judge sees it. Location/remote are deliberately WITHHELD — the rubric forbids
 *  judging on them, and the surest way to enforce that is to not show them. */
function renderJob(candidate: PoolCandidate): string {
  return `=== Job posting ===\nTitle: ${candidate.title.trim()}\n\nDescription:\n${candidate.descriptionText.trim()}`;
}

export interface JudgeResult extends LabelVerdict {
  usage: { inputTokens: number; outputTokens: number };
  cache: { creationInputTokens: number; readInputTokens: number };
}

/**
 * Draft one verdict. ONE candidate per call on purpose: a chunked call scores each job in the
 * company of its neighbours, which is the relative-judgment bias the production rubric spends a
 * paragraph warning against — tolerable when the output is an ordering, not when it is the ground
 * truth. Temperature 0 for reproducibility.
 *
 * `cacheSystem` marks the rubric+profile prefix as an Anthropic cache breakpoint; it is a silent
 * no-op below the model's minimum cacheable prefix, so the caller REPORTS the returned counters
 * rather than assuming caching engaged.
 */
export async function judgeCandidate(
  system: string,
  candidate: PoolCandidate,
  model: ModelAlias,
): Promise<JudgeResult> {
  const { object, usage, cache } = await generateObject({
    model,
    schema: LabelVerdictSchema,
    system,
    cacheSystem: true,
    temperature: 0,
    // Generous headroom over the ~100 tokens a verdict actually costs. A truncated response is not a
    // soft failure here: generateObject throws on unparseable JSON, and at temperature 0 every retry
    // reproduces the same overrun — so one verbose reason would take down a whole pool's run.
    maxOutputTokens: 1024,
    messages: [{ role: "user", content: renderJob(candidate) }],
  });
  return {
    ...object,
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
    cache,
  };
}
