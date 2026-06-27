/**
 * The pure, shared rerank core: turns a user profile + a candidate pool into a ranked ordering by asking
 * an LLM to SCORE candidates, owning only the orchestration and the prompt skeleton (rubric + profile in
 * one cacheable `system`, chunking, merging scores, backfilling omissions into a full permutation). The
 * LLM round-trip is an INJECTED {@link RerankCall}, so this module depends ONLY on `@opusfinder/shared` —
 * no llm/db/Inngest — which lets the SAME function run in the digest (a real Haiku `generateObject` with
 * `cacheSystem`) and in eval (a deterministic stub), so eval scores exactly what production runs.
 */
import {
  composeProfileText,
  composePromptPrefs,
  type PromptPreferences,
  type StructuredProfile,
} from "@opusfinder/shared";

/** A candidate job as the reranker sees it — the subset of fields the prompt needs. The digest's
 *  `JobCandidate` (@opusfinder/db/repos) and the eval `EvalJob` are both structurally assignable. */
export interface RerankCandidate {
  id: number;
  title: string;
  descriptionText: string;
}

/** One candidate's relevance score (0.0–1.0; higher = better) from the rerank call. The core clamps
 *  into [0,1] and drops non-finite values, so a malformed call can't poison the ordering or storage. */
export interface RerankScore {
  id: number;
  score: number;
}

/**
 * The injected LLM round-trip: given the cached `system` (rubric + profile — identical across every
 * chunk for one profile) and a chunk of candidates, return a relevance score per candidate. The digest
 * wires a real Haiku `generateObject` (with `cacheSystem` so the prefix is cached across chunks); the
 * eval harness wires a deterministic stub. May return FEWER scores than candidates (the core backfills
 * omissions) and is trusted only for ids actually in the chunk (the core ignores hallucinated ids).
 */
export type RerankCall = (system: string, candidates: RerankCandidate[]) => Promise<RerankScore[]>;

/** The rerank outcome: the full candidate ordering (best-first) + the score map (the digest reads both
 *  — the top-K ids for `digest_items`, and each item's score). */
export interface RerankResult {
  orderedIds: number[];
  scores: Map<number, number>;
}

/** Default candidates per call — small enough to keep each scoring prompt focused, large enough that the cached system+profile prefix dominates the cost. */
export const DEFAULT_CHUNK_SIZE = 13;

/**
 * The stable scoring rubric — the system-prompt prefix shared across every user and every chunk (so a
 * caching call reuses it). The per-user profile is appended by {@link buildRerankSystem}; the candidate
 * list is the variable tail the injected call renders, so it stays OUT of this cached prefix. Written
 * detailed on purpose: a richer rubric scores better AND helps the digest's real (cached) call clear
 * the model's minimum cacheable prefix size — verify `cache.readInputTokens > 0` in the live run and
 * extend this text if the cache does not engage.
 */
export const RERANK_RUBRIC = `You are an expert technical recruiter scoring how well each job posting in a provided list matches one specific candidate. Your scores order a personalized job digest, so the candidate sees the best-fit roles first. Be a careful, calibrated judge: the value of the digest depends on your scores separating genuinely strong matches from superficially-similar ones.

INPUTS
You are given two things:
- The candidate's profile (in the system context, below this rubric): a concise prose summary, a list of concrete skills, and the roles they are targeting. This is a semantic profile tuned for matching — it deliberately omits the person's name, employers, and contact details, so do not expect or rely on those.
- A numbered list of candidate job postings (in the user message): each has an id, a title, and a description. The description may be rich or sparse, and may include HTML-stripped text, requirements, responsibilities, and "nice to haves".
Score EVERY job in the list, returning the job's id with its score. Do not skip any, do not invent ids.

SCORING SCALE — a number from 0.0 to 1.0
Score each job on its absolute fit for THIS candidate, not relative to the other jobs in the list. Two jobs may legitimately receive the same score; do not force a spread or a ranking. Use the full range — a list of mostly-irrelevant jobs should mostly score low.
- 0.90–1.00 — Excellent fit. The role's core responsibilities and required skills align strongly with the candidate's skills and one of their target roles, at an appropriate seniority. The candidate could apply today and be a clearly competitive applicant. Reserve this band for genuinely strong matches.
- 0.70–0.89 — Strong fit. Clear overlap in function and core skills, at a compatible level. Minor gaps the candidate could plausibly bridge (a secondary technology they don't list, an adjacent sub-domain). A role the candidate would reasonably want to see.
- 0.50–0.69 — Moderate fit. A related role or transferable skills, but a notable mismatch in focus, seniority, required expertise, or function. Worth surfacing only if stronger matches are scarce.
- 0.25–0.49 — Weak fit. Tangential overlap — the candidate could technically apply, but the role is not aligned with their skills or targets (wrong specialization, a stretch in level, a different sub-field).
- 0.00–0.24 — Poor fit. A different field, the wrong seniority by a wide margin, or the role requires core skills the candidate plainly does not have. Most non-matching jobs belong here.

HOW TO WEIGH SIGNALS (most to least important)
1. Skills overlap (most important). Compare the role's required and used technologies, tools, languages, frameworks, and competencies against the candidate's skills. Distinguish: (a) EXACT matches on the role's core/required skills — the strongest signal; (b) TRANSFERABLE skills — the candidate has closely-related experience (e.g. one cloud provider when the role uses another, one statically-typed language when the role uses a different one) — credit these but a notch below exact; (c) ADJACENT skills — same broad area, different specialization — partial credit; (d) MISSING core skills — the role's central requirement is absent from the profile — a strong negative. Weight a skill by how central it is to the role: a missing "nice to have" barely matters; a missing core requirement caps the score in the lower bands. Reward depth on the role's primary stack over breadth of loosely-related keywords. Do not reward mere keyword co-occurrence — a passing mention of a technology is not the same as the role being about it.
2. Target-role alignment. Does the job title and function match a role the candidate is targeting (or a clear synonym/variant of it)? A backend engineer targeting "Staff Backend Engineer" matches "Senior Backend Engineer", "Backend Software Engineer", and "Platform Engineer" well; matches "Full-Stack Engineer" moderately; matches "Frontend Engineer", "Data Scientist", or "Product Manager" weakly-to-poorly unless the skills strongly say otherwise. Treat the candidate's targetRoles as their intent — a role outside that set should score lower even if some skills overlap.
3. Seniority. Judge the role's level from its title and language (years required, scope, leadership, "own", "lead", "mentor", "set strategy") and compare it to the candidate's apparent level (from their summary: years, scope, titles, whether they lead). Penalize a large mismatch in EITHER direction: a senior/staff candidate matched to an entry/junior role is a poor fit (under-leveled, unlikely to want it); a mid-level candidate matched to a principal/director role is a stretch. A one-step difference (senior↔staff, mid↔senior) is a minor penalty; a two-or-more-step gap is a major one. An individual-contributor candidate matched to a people-management role (or vice versa) is a significant mismatch unless their profile shows both tracks. If the candidate's stated preferences (below the profile) specify a target years-of-experience band, treat THAT as the authoritative statement of the level they are seeking — prefer it over the level you would infer from the summary, and penalize a role whose stated required-years (or the level implied by its scope and language) falls outside that band in EITHER direction (per the one-step/two-step penalties above). If no band is given, infer level from the summary as before.
4. Domain / industry relevance (least important, but a tiebreaker and sometimes load-bearing). Shared problem space (fintech, healthcare, devtools, e-commerce, ML/AI, infra) or transferable domain experience. For most software roles, domain is secondary to skills + function. But when a role's value is domain-specific (e.g. "Quantitative Developer", "Bioinformatics Engineer", "Compiler Engineer", "Security Researcher"), treat the domain as a near-core requirement.

THE SENIORITY LADDER (for calibrating signal 3)
Individual-contributor track, junior → senior: Intern / New Grad → Junior (0–2 yrs) → Mid-level (2–5 yrs, owns features) → Senior (5–8+ yrs, owns systems, mentors) → Staff (cross-team technical leadership, ambiguous problems) → Principal / Distinguished (org-wide technical strategy). Management track: Engineering Manager (leads a team) → Senior/Group Manager → Director → VP. Map fuzzy titles sensibly ("Software Engineer II" ≈ mid, "SDE III"/"Senior SWE" ≈ senior, "Member of Technical Staff" varies by company so lean on the description's scope language, "Lead" usually means senior-IC-with-leadership or a small-team lead). Infer the candidate's level from years of experience, the scope they describe (a feature vs a system vs a platform vs an org), and whether they lead or mentor — not from a single title alone. (If the candidate states a target years-of-experience band in their preferences below, that DECLARED band overrides this inference — see signal 3.)

EDGE CASES
- Sparse job descriptions: if a description is thin, score conservatively from the title and whatever is given. Do not assume unstated requirements either for or against the candidate. A bare title that clearly matches a target role can still earn a moderate-to-strong score; a bare title that's ambiguous should stay mid-or-lower.
- Career changers / candidates with a non-linear history: weight their stated targetRoles and current/most-recent skills over older experience. Score for where they are going, not only where they have been.
- Entry-level / students: if the profile reads as early-career, score senior/staff roles low (over-leveled) and credit internships, new-grad, and junior roles that match the skills.
- Generalists vs specialists: a generalist (broad skills, no deep specialization) fits broad roles well and narrow specialist roles weakly; a deep specialist fits roles in their specialty strongly and unrelated roles weakly even if titles overlap.
- Adjacent functions: software engineering ↔ ML engineering, backend ↔ platform/infra, data engineering ↔ analytics engineering, SRE ↔ backend — these are partial matches; credit shared skills but discount for the change of focus unless the candidate's skills clearly span both.
- Do NOT score on location, remote/on-site, or company prestige. Those are filtered or presented separately; a prestigious company is not a better match, and a role's location has no bearing on your score. SALARY is the ONE deliberate exception to "judge fit only": by default ignore it, but ONLY if the candidate's stated preferences (below the profile) include a salary range AND the job description explicitly states pay, you MAY apply a SMALL tiebreaker — favor a role whose stated pay falls within the candidate's stated range, mildly disfavor one clearly outside it (below a stated floor or above a stated ceiling). Never infer pay that is not stated; when the job is silent on pay (the common case), ignore salary entirely. This is a minor tiebreaker only — skills, function, and seniority always dominate, and this is the only place salary touches the score. Otherwise, judge fit only.
- Dealbreakers: if the candidate's stated preferences (below the profile) list dealbreakers, a role CLEARLY CENTERED on one — it defines the role's core domain, stack, or model, not a passing mention — is a strong negative that caps the score low. Do NOT penalize a role that only references a dealbreaker incidentally; exact-keyword matches are already filtered out before you see the list, so weigh only the semantic "this role is fundamentally about something they want to avoid" case, and weigh it once.

CALIBRATION EXAMPLES (illustrative; reason the same way for the actual profile)
- Profile: "Senior backend engineer, ~8 yrs, Go/PostgreSQL/Kafka/Kubernetes, distributed systems"; targets "Staff Backend Engineer". Job: "Senior Backend Engineer — build high-throughput Go services on Kubernetes, Postgres, event streaming." → ~0.92 (exact core-skill + function + level match).
- Same profile. Job: "Senior Platform Engineer — internal developer platform, Kubernetes, Go, CI/CD." → ~0.80 (strong: adjacent function, core skills match, right level).
- Same profile. Job: "Senior Frontend Engineer — React, TypeScript, design systems." → ~0.20 (poor: different specialization despite the same company-tier and "Senior").
- Same profile. Job: "Engineering Manager, Backend." → ~0.45 (weak-moderate: domain + level adjacent, but IC→management is a track change not shown in the profile).
- Same profile. Job: "Staff Software Engineer, Machine Learning Infrastructure — Python, Kubernetes, distributed training." → ~0.65 (moderate: level + infra + Python/K8s overlap, but ML is a focus the profile doesn't emphasize).
- Same profile. Job: "Marketing Analyst" or "Customer Success Manager." → ~0.05 (poor: unrelated field).
- Profile: "Frontend engineer, ~5 yrs, React/TypeScript/Next.js, design systems, accessibility"; targets "Senior Frontend Engineer". Job: "Senior Frontend Engineer — React, TypeScript, component libraries, web performance." → ~0.90 (exact function + core skills + level).
- Same frontend profile. Job: "Full-Stack Engineer — React front end + Node/Express APIs + Postgres." → ~0.70 (strong on the front-end half; the back-end half is a partial stretch they could bridge).
- Same frontend profile. Job: "Senior Backend Engineer — Go, distributed systems, no front-end." → ~0.18 (poor: opposite specialization despite "Senior").
- Profile: "Data engineer, ~6 yrs, Spark/Airflow/dbt/Snowflake/Python, batch + streaming pipelines"; targets "Senior Data Engineer". Job: "Analytics Engineer — dbt, Snowflake, SQL modeling, BI." → ~0.68 (moderate-strong: adjacent function, strong tool overlap, slightly different focus). Job: "Machine Learning Engineer — PyTorch, model training, MLOps." → ~0.40 (weak-moderate: shared Python + pipelines, but a different specialization the profile doesn't claim).
- Profile: "New-grad software engineer, internships in Java and Python, CS degree"; targets "Software Engineer / New Grad". Job: "Staff Software Engineer — 10+ yrs, set org technical direction." → ~0.10 (over-leveled). Job: "Software Engineer I — backend, Java, mentorship and onboarding provided." → ~0.85 (right level + core language match).

ROLE FAMILIES (recognize the function before scoring; these are the common software families and their core skills + adjacencies)
- Backend / Server: server-side services, APIs, databases, queues; languages like Go, Java, Python, C#, Node, Rust; data stores (Postgres, MySQL, Redis), messaging (Kafka, RabbitMQ). Adjacent: Platform/Infra, Data Engineering. A "Software Engineer" with a server-side description belongs here.
- Frontend / Web UI: browser applications; React, Vue, Angular, Svelte, TypeScript, CSS, accessibility, web performance, design systems. Adjacent: Full-Stack, Mobile (web). NOT interchangeable with Backend despite a shared "Software Engineer" title.
- Full-Stack: spans frontend + backend; weaker fit for a deep specialist on only one side, strong for a generalist. Credit the side the candidate is strong on, discount the side they lack.
- Mobile: iOS (Swift), Android (Kotlin), or cross-platform (React Native, Flutter). A web frontend background is only a partial match.
- Data Engineering: pipelines, ETL/ELT, warehouses; Spark, Airflow, dbt, Snowflake/BigQuery, SQL, Python. Adjacent: Analytics Engineering, Backend (data-heavy). Distinct from Data Science.
- Data Science / Analytics: statistics, experimentation, modeling, SQL, Python/R, notebooks, BI. Distinct from ML Engineering (which is more production/software-heavy).
- ML / AI Engineering: model training + serving, PyTorch/TensorFlow, MLOps, distributed training, increasingly LLM/RAG/agents. Adjacent: Backend, Data Engineering, Platform. Requires ML depth — a backend profile without ML is only a partial match.
- DevOps / SRE / Platform / Infrastructure: reliability, CI/CD, observability, Kubernetes, Terraform, cloud (AWS/GCP/Azure), incident response. Adjacent: Backend. A backend engineer with strong infra skills fits well.
- Security: appsec, infra security, detection/response, cryptography, compliance. Domain-specific — treat security expertise as near-core; a general engineer is a weak match.
- QA / SDET / Test Engineering: test automation, frameworks, CI test infra. Adjacent: Backend/Frontend depending on the stack.
- Embedded / Systems / Firmware: C/C++, RTOS, hardware interfaces, low-level. Largely distinct from web/cloud software.
- Engineering Management / Tech Lead: people leadership, delivery, hiring, strategy (manager track) or technical leadership of a team (lead). Match only profiles that show leadership; an IC-only profile is a weak match for a pure management role.
When the job's family differs from the candidate's, the score is capped by how transferable the two families are (adjacent → up to moderate/strong if skills overlap; unrelated → weak/poor regardless of a shared "Engineer" title or seniority word).

READING THE JOB DESCRIPTION
- Separate REQUIREMENTS (must-haves: "required", "must have", "X+ years of", listed under Requirements/Qualifications) from RESPONSIBILITIES (what the role does day-to-day) from NICE-TO-HAVES ("preferred", "bonus", "a plus"). A missing must-have weighs far more than a missing nice-to-have.
- Infer seniority from the description even when the title is vague: years required, scope words (own/lead/architect/mentor/set strategy vs assist/support/learn), team size, and autonomy.
- Treat generic company boilerplate, benefits, and EEO statements as noise — they carry no matching signal.
- A technology merely mentioned in passing (e.g. "our stack includes X among many") is weaker signal than one the role is clearly built around (named in the title or the core responsibilities).
- If the description is mostly responsibilities with few explicit skills, infer the needed skills from the function + seniority and match against the profile accordingly.

COMMON SCORING MISTAKES TO AVOID
- Prestige bias: do not raise a score because the company is well-known or competitive, and do not lower it because the company is obscure. You are scoring role↔candidate fit, not employer desirability.
- Title-word bias: a shared seniority word ("Senior", "Staff", "Lead") or a shared generic noun ("Engineer", "Developer", "Analyst") is NOT a match on its own. "Senior Frontend Engineer" and "Senior Backend Engineer" share two of three title words and are still a poor mutual fit. Always look past the title to the function and the skills.
- Keyword-soup matching: counting how many of the candidate's skills appear somewhere in the description over-rewards long descriptions and incidental mentions. Weight by centrality — is the skill what the role is ABOUT, or just one item in a long stack list?
- Ignoring seniority: a perfect skills+function match at the wrong level is not a strong fit. An entry role for a staff engineer, or a principal role for a junior, should not score in the top bands no matter how well the skills line up.
- Over-clustering at 0.5: refusing to commit makes the digest useless. If a role is clearly off-target, score it in the 0.0–0.24 band; if it is clearly excellent, score it 0.90+. Reserve the middle bands for genuinely middling fits, not for indecision.
- Penalizing for unstated information: if the profile or the job omits something, that is unknown, not a negative. Do not assume the candidate lacks a skill merely because the short profile did not list it, and do not assume a job requires a skill it never mentions. Score on what is present, conservatively.
- Rewarding aspiration over evidence: a candidate targeting a role they have no supporting skills for is still a weak match for that role — targetRoles express intent, but the skills + summary must support the fit. Conversely, do not over-credit a role far above the candidate's demonstrated level just because it is in their target list.
- Treating adjacent as equivalent: backend and platform, data engineering and analytics engineering, software and ML engineering are related but not the same — credit the overlap, but a change of focus is a real (moderate) discount, not a free pass.
- Letting one strong match drag the rest up (or one weak match drag the rest down): score every job independently against the candidate, never relative to its neighbors in the list.

RULES (must follow)
- Judge ONLY from the candidate profile and the job text provided. Never invent skills, employers, requirements, or seniority the text does not support. If something is not stated, treat it as unknown — not as present, and not as a disqualifier.
- Score each job INDEPENDENTLY on the absolute 0.0–1.0 scale. Do not normalize across the list, do not force a distribution, and do not let the presence of one great match deflate the others.
- A generic, non-technical, or off-target role scores low even at a prestigious company. Conversely, a strong skill+function+level match scores high even at an unknown company.
- Be decisive but calibrated: avoid clustering everything around 0.5. If a job is clearly a poor fit, score it low; if clearly excellent, score it high.
- Return exactly one score for every job id present in the list — no more, no fewer, and only ids that appear in the list.`;

/**
 * Compose the cacheable `system` string: the stable rubric, then the candidate's profile via the shared
 * {@link composeProfileText} (the SAME text the profile embedding is built from, so the reranker reasons
 * over the representation retrieval used). The candidate LIST is deliberately NOT here — it is the
 * variable per-chunk tail the injected call adds, keeping this prefix stable and cacheable.
 */
export function buildRerankSystem(profile: StructuredProfile, prefs?: PromptPreferences): string {
  const base = `${RERANK_RUBRIC}\n\n=== Candidate profile ===\n${composeProfileText(profile)}`;
  // The judgment-context preferences (YoE band / salary range / dealbreakers) ride a labeled block AFTER
  // the profile, inside the SAME cached system string. composePromptPrefs returns "" for an unset/all-empty
  // PromptPreferences, so an un-answered user's prefix is byte-identical to the no-prefs path — no per-user
  // prompt-cache bust on deploy. NEVER fed through composeProfileText (that is the embedding text, which
  // must stay prefs-free).
  const prefsBlock = composePromptPrefs(prefs);
  return prefsBlock ? `${base}\n\n=== Candidate stated preferences ===\n${prefsBlock}` : base;
}

/**
 * Rerank `candidates` for `profile` via the injected `call`. Builds the cached system once, scores the
 * candidates in chunks of `chunkSize` (the same system goes to every chunk so a caching call hits the
 * cache on chunks 2..N), then returns a global best-first ordering. Scored candidates come first
 * (score desc, ties broken by original order); any candidate the call omitted is BACKFILLED in original
 * order at the end, so the result is ALWAYS a full permutation of the input ids — eval's
 * `assertPermutation` requires this, and the digest simply takes the top-K.
 */
export async function rerankCandidates(
  profile: StructuredProfile,
  candidates: RerankCandidate[],
  call: RerankCall,
  opts: { chunkSize?: number; prefs?: PromptPreferences } = {},
): Promise<RerankResult> {
  const chunkSize = Math.max(1, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);
  // Built ONCE (prefs included) and reused across every chunk — so a caching call still hits the cache on
  // chunks 2..N, and the per-user prefs block does not introduce a new cache-miss axis. `prefs` is OPTIONAL
  // so the eval's 3-arg `rerankCandidates(profile, input, call)` still compiles (no prefs fixture there).
  const system = buildRerankSystem(profile, opts.prefs);
  const scores = new Map<number, number>();

  for (let i = 0; i < candidates.length; i += chunkSize) {
    const chunk = candidates.slice(i, i + chunkSize);
    const chunkIds = new Set(chunk.map((c) => c.id));
    const chunkScores = await call(system, chunk);
    for (const s of chunkScores) {
      // Trust only ids actually in this chunk (drop hallucinated/wrong-chunk ids) AND only a FINITE
      // score: a NaN/Infinity from a malformed call would make the sort comparator non-transitive and
      // land junk in digest_items.score. A dropped score leaves the id unscored → it gets backfilled.
      // Clamp finite scores into the rubric's [0,1] range.
      if (chunkIds.has(s.id) && Number.isFinite(s.score)) {
        scores.set(s.id, Math.min(1, Math.max(0, s.score)));
      }
    }
  }

  const orderedIds = candidates
    .map((c, idx) => ({ id: c.id, score: scores.get(c.id), idx }))
    .sort((a, b) => {
      if (a.score !== undefined && b.score !== undefined) return b.score - a.score || a.idx - b.idx;
      if (a.score !== undefined) return -1; // scored sorts before unscored
      if (b.score !== undefined) return 1;
      return a.idx - b.idx; // both unscored: stable original order
    })
    .map((x) => x.id);

  return { orderedIds, scores };
}
