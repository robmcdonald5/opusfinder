// Public surface of @opusfinder/db/repos — the persistence layer over the
// Drizzle schema. Imported by ingestion scripts (and later Workers) to write
// normalized jobs through to Neon.
export { upsertCompany, upsertJobs, listCompanies } from "./jobs";
export type { CompanyRow } from "./jobs";
export {
  startRun,
  finishRun,
  failStaleRuns,
  listCompaniesForReprobe,
  listCompanyStates,
  markProbeResult,
  markProbed,
  deactivateStale,
} from "./discovery";
export type { CompanyState } from "./discovery";
export {
  jobsNeedingEmbedding,
  writeJobEmbeddings,
  backfillJobEmbeddings,
  nearestJobs,
  jobEmbeddingText,
} from "./embeddings";
export type { JobNeedingEmbedding, JobNeighbor } from "./embeddings";
export {
  insertCvFile,
  patchCvFileExtracted,
  markCvFileFailed,
  upsertUserProfile,
  getProfileTextKey,
} from "./profiles";
export type { NewCvFile, UpsertUserProfileInput, ProfileTextRef } from "./profiles";
export { getPreferences, getOrCreatePreferences, updatePreferences } from "./preferences";
export type { UserPreferencesRow, CreatePreferencesInput } from "./preferences";
