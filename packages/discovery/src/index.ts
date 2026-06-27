// Public surface of @opusfinder/discovery.
export { probeFetch, probeCandidate, probeCandidates, defaultClassify } from "./probe";
export type { ProbeFetchResult, ProbeOptions } from "./probe";
export { loadSeed, SEED_URL, SEED_LANES } from "./seed";
export type { CompanyRecord, SeedLane } from "./seed";
export { resolveUrl, resolveSeed } from "./resolve";
export type { ResolveCounts } from "./resolve";
export { runDiscovery } from "./discover";
export type { DiscoveryOptions, DiscoveryCounts } from "./discover";
export type { Candidate, ProbeResult, ProbeOutcome } from "./types";
