// Public surface of @opusfinder/sources. Phase 6 extracts a shared adapter abstraction:
// a thin `runAdapter` (invariant plumbing — fetch, retry/backoff, pagination, hydrate pool)
// + per-source `SourceAdapter` descriptors, behind a source-name → adapter registry. The
// entry point is the two-arg `fetchJobs(source, slug)`.
export { fetchJobs, adapters, SOURCE_NAMES, isSourceName } from "./adapters";
export { runAdapter } from "./adapters/run-adapter";
export type { RunAdapterOptions } from "./adapters/run-adapter";
export type {
  SourceAdapter,
  SourceContext,
  JobsRequest,
  FetchJson,
  Cursor,
} from "./adapters/types";
export type { NormalizedJob, SourceName } from "@opusfinder/shared";
