// Public surface of @opusfinder/sources. Ingestion enters through `runIngestion` (the Worker cron and
// both CLIs); discovery uses the source-name → adapter registry and the probe types.
export { adapters, SOURCE_NAMES, CASE_INSENSITIVE_SLUG_SOURCES, isSourceName } from "./adapters";
export { runIngestion } from "./ingest";
export type { IngestionOptions, IngestionCounts, IngestEmbedFn, IngestBoardResult } from "./ingest";
// Shared HTML→text primitive (pure string ops, Worker-safe) — the HN discovery lane decodes `&#x2F;`
// board URLs via cleanHtml(text, ["decode"]) rather than hand-rolling a weaker copy.
export { cleanHtml } from "./adapters/text";
export type { SourceAdapter, SourceContext, JobsRequest, ProbeOutcome } from "./adapters/types";
