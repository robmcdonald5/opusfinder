import type { CompanySlug, SourceName } from "@opusfinder/shared";
import type { ProbeOutcome } from "@opusfinder/sources";

export type { ProbeOutcome };

/**
 * A resolved discovery candidate — a (source, slug) pair the prober can validate, plus provenance.
 * The seed resolver produces these: `slug` is the canonical post-`normalizeSlug` form, `rawSlug` is the
 * segment/label `matchUrl` returned (pre-normalize), and `sourceUrl` is the seed URL it was resolved from.
 */
export interface Candidate {
  source: SourceName;
  slug: CompanySlug;
  rawSlug: string;
  sourceUrl: string;
}

/** The classified outcome of probing one candidate. The (possibly large) response body is NOT kept. */
export interface ProbeResult {
  candidate: Candidate;
  /** HTTP status of the final attempt, or 0 if the network attempt was exhausted. */
  status: number;
  outcome: ProbeOutcome;
}
