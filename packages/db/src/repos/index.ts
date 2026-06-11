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
  getProfileForDigest,
} from "./profiles";
export type {
  NewCvFile,
  UpsertUserProfileInput,
  ProfileTextRef,
  ProfileForDigest,
} from "./profiles";
export { getPreferences, getOrCreatePreferences, updatePreferences } from "./preferences";
export type { UserPreferencesRow, CreatePreferencesInput } from "./preferences";
// Phase 10 digest retrieval — the deterministic filter + cosine ranking over a profile vector.
export { retrieveCandidatesForProfile } from "./retrieval";
export type { RetrieveOpts, JobCandidate } from "./retrieval";
// Phase 10 digest persistence — recipient list, already-shown anti-join, run/header/item writes.
export {
  listDigestRecipients,
  alreadyShownJobIds,
  startDigestRun,
  finishDigestRun,
  insertDigest,
  insertDigestItems,
  deleteUserDigestForRun,
  getLatestDigestForUser,
} from "./digests";
export type { DigestRecipient, NewDigest, NewDigestItem, DigestView } from "./digests";
// Phase 11 email delivery — the render payload read + per-send / user-level delivery-state writes.
export {
  getDigestEmailPayload,
  recordDigestSent,
  recordDigestDeliveryOutcome,
  recordDigestSendFailure,
} from "./digests";
export type { DigestEmailPayload, DigestDeliveryOutcome } from "./digests";
