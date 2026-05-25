// Public surface of @opusfinder/sources. Phase 1 ships only the concrete
// Greenhouse adapter — NO shared adapter interface or registry yet. That
// abstraction is extracted in Phase 6 once 2–3 real adapters reveal what varies.
export { fetchJobs } from "./greenhouse";
export type { NormalizedJob, SourceName } from "@opusfinder/shared";
