/**
 * Eval harness types (Phase 5).
 *
 * The harness scores a *ranking* of candidate jobs against a labeled relevance set. The
 * load-bearing idea: vector retrieval and the (Phase 10) LLM rerank both emit a ranking,
 * so ONE metrics core scores both — they differ only in the `Ranker` implementation. The
 * embedding-model comparison (Voyage vs OpenAI) is likewise just two `Ranker`s built from
 * different `embed` functions, so it reuses the entire scoring path for free.
 */

import type { StructuredProfile } from "@opusfinder/shared";

/**
 * Eval-time stand-in for a user profile. PROVISIONAL: Phase 9 introduces the real
 * `user_profiles` row (PDF → structured JSONB + embedding); this mirrors that planned
 * `{ summary, skills, target roles, preferences }` shape so the harness can score matching
 * today, and Phase 9 can later feed real extracted profiles through the same `EvalExample`
 * format. Holds NO PII (no name / contact / employer) even when derived from a real CV —
 * see the package README.
 */
export interface EvalProfile extends StructuredProfile {
  /** Stable, non-identifying handle for the example (e.g. "backend-ic-1"). */
  id: string;
  // summary / skills / targetRoles are inherited from StructuredProfile (@opusfinder/shared) — the
  // SAME shape production `user_profiles.structured` uses — so the two can't drift. EvalProfile adds
  // only the eval-local handle (`id`) and labeling `preferences`.
  /**
   * Hard-ish preferences. NOT enforced as filters in Phase 5 (the Phase 10 deterministic
   * filter will use them); kept here so labeled examples carry them forward unchanged.
   */
  preferences?: {
    remote?: boolean;
    locations?: string[];
    minSalary?: number;
  };
}

/**
 * A candidate job, snapshotted into the dataset. Deliberately a FROZEN copy of the fields
 * a ranker sees (title + description drive the embedding; locations/remote feed the future
 * filter), NOT a live DB read — labeled data must not drift as the `jobs` table changes.
 * `id` is the real `jobs.id`, so a label traces back to its source row.
 */
export interface EvalJob {
  id: number;
  title: string;
  descriptionText: string;
  locations?: string[];
  remote?: boolean;
}

/**
 * One labeled example: a profile, the candidate pool it was judged against, and the ids
 * judged a good match. Binary relevance (`expectedGoodIds`) is the v1 label; graded
 * relevance can be added later if a metric needs it.
 */
export interface EvalExample {
  profile: EvalProfile;
  candidateJobs: EvalJob[];
  /** Subset of `candidateJobs[].id` judged relevant — the ground truth metrics score against. */
  expectedGoodIds: number[];
  /** Optional note on how this example was labeled (provenance / rationale). */
  notes?: string;
}

/**
 * Orders candidate ids best-first. The harness's central abstraction: the random stub, the
 * embedding ranker (Voyage / OpenAI), and the Phase-10 LLM rerank are all `Ranker`s, so they
 * run through the identical scoring path. Async because real rankers hit a network (embeddings
 * API / LLM). MUST return a permutation of the candidate ids it was given — the runner
 * validates this so a buggy ranker can't silently inflate its score by dropping hard items.
 */
export type Ranker = (profile: EvalProfile, candidates: EvalJob[]) => Promise<number[]>;

/**
 * Produces a short per-job "why this matched" reason. Defined now so the Phase-10 digest
 * synthesis plugs into the harness; Phase 5 only structurally validates output (one
 * non-empty reason per ranked id), since judging synthesis QUALITY needs the Phase-10
 * Sonnet pipeline to exist first.
 */
export type SynthesisFn = (
  profile: EvalProfile,
  ranked: EvalJob[],
) => Promise<{ id: number; reason: string }[]>;
