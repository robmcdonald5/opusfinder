// Public surface of @opusfinder/profiles — the CV → semantic-profile pipeline (Phase 9). All three
// entry points are argv-free and take their heavy dependencies (transcribe / structure / embed /
// storage / db) INJECTED, so this module stays Worker-portable; the Node scripts/ wire the real impls.
export { ingestCv } from "./ingest";
export type { IngestCvOptions, IngestCvResult } from "./ingest";
export { reembedProfile } from "./reembed";
export { restructureProfile } from "./restructure";
export type { ProfileEmbedFn, StructureFn, TranscribeFn } from "./types";
