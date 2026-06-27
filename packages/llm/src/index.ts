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
// Digest prompts: the rerank output schema + candidate renderer, and the synthesis rubric +
// renderers. The rerank SCORING rubric + orchestration live in @opusfinder/rerank (shared with eval).
export { RerankScoresSchema, renderRerankCandidates } from "./prompts/rerank";
export type { RerankScores } from "./prompts/rerank";
export { DIGEST_SYNTHESIS_SYSTEM, buildDigestSystem, renderDigestJob } from "./prompts/digest";
