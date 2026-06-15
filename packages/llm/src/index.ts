export { generate } from "./generate";
export type { GenerateParams, GenerateResult, ModelAlias } from "./generate";
export { batchGenerate, submitBatch, pollBatch, collectBatchResults } from "./batch";
export type {
  BatchRequest,
  BatchResult,
  BatchResultStatus,
  BatchUsage,
  BatchGenerateOptions,
  BatchPoll,
  BatchProcessingStatus,
} from "./batch";
export { generateObject } from "./generate-object";
export type { GenerateObjectParams, GenerateObjectResult } from "./generate-object";
export { pdfPart } from "./file-part";
export { CV_TRANSCRIBE_SYSTEM, CV_STRUCTURE_SYSTEM, CvProfileSchema } from "./prompts/cv-extract";
export type { CvProfile } from "./prompts/cv-extract";
// Phase F4 job-side enrichment: the strict null-when-absent prompt + schema + the pure extractor core. The
// real generateObject-backed call is injected by the Node caller (4d) / eval (4e), so they share one path.
export { JOB_ENRICH_SYSTEM, JobEnrichmentSchema } from "./prompts/job-enrich";
export { makeJobEnrichmentExtractor } from "./job-enrich-extractor";
// Phase 10 digest prompts: the rerank output schema + candidate renderer, and the synthesis rubric +
// renderers. The rerank SCORING rubric + orchestration live in @opusfinder/rerank (shared with eval).
export { RerankScoresSchema, renderRerankCandidates } from "./prompts/rerank";
export type { RerankScores } from "./prompts/rerank";
export { DIGEST_SYNTHESIS_SYSTEM, buildDigestSystem, renderDigestJob } from "./prompts/digest";
