// Public surface of @opusfinder/db/repos — the persistence layer over the
// Drizzle schema. Imported by ingestion scripts (and later Workers) to write
// normalized jobs through to Neon.
export { upsertCompany, upsertJobs, listCompanies } from "./jobs";
export type { CompanyRow, UpsertJobsResult } from "./jobs";
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
  embedNextPage,
  EmbedCountMismatchError,
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
export {
  getPreferences,
  getOrCreatePreferences,
  updatePreferences,
  setDigestApproval,
  anyHasHomePlace,
} from "./preferences";
export type { UserPreferencesRow, CreatePreferencesInput } from "./preferences";
// Digest retrieval — the deterministic filter + location rule + cosine ranking over a profile vector.
export { retrieveCandidatesForProfile, candidateFilterSql, countLocalStrings } from "./retrieval";
export type { RetrieveOpts, JobCandidate } from "./retrieval";
export {
  locationRule,
  homeAndStringFlagsSql,
  milesBetween,
  EARTH_RADIUS_MILES,
} from "./location-rule";
export type { LocationFilter, LocationRuleSql } from "./location-rule";
// The GeoNames gazetteer and the normalizer's resolved location strings.
export {
  upsertPlaces,
  listCountriesAndRegions,
  getPlaces,
  findCities,
  cityKey,
  findHomeCandidates,
  findHomePlace,
} from "./places";
export type { Place, CityMatch, HomeCandidate, HomePlaceLookup } from "./places";
export {
  listPendingPairs,
  listCompanyStrings,
  upsertLocationStrings,
  activePairsSql,
  locationTextsSql,
  MAX_LOCATION_RAW_BYTES,
} from "./location-strings";
export type { LocationPair, LocationPairKey, LocationStringRow } from "./location-strings";
// locations:report / locations:explain reads.
export {
  coverageBySource,
  pairStatus,
  reportList,
  explainJob,
  cosineRankIgnoringLocation,
} from "./location-report";
export type {
  SourceCoverage,
  PairStatus,
  ReportRow,
  ReportList,
  ExplainedString,
  ExplainedJob,
} from "./location-report";
// Lifecycle closing — the first writers of lifecycle_state='closed' (feed-absence sweep + board-death + 410-close).
export {
  sweepLifecycle,
  closeJobsForCompanies,
  closeJobsByIds,
  markJobsPresent,
  markCompanyIngested,
  sweepStaleJobs,
  ABSENCE_CLOSE_THRESHOLD,
  DEFAULT_STALE_TTL_DAYS,
} from "./lifecycle";
export type { SweepResult, SweepOptions, CloseResult } from "./lifecycle";
// The weekly job prune the scrapers Worker runs after discovery (the owner's script imports prune.ts directly).
export { runPrune } from "./prune";
export type { PruneRunCounts } from "./prune";
// Digest persistence — recipient list, already-shown anti-join, run/header/item writes.
export {
  listDigestRecipients,
  alreadyShownJobIds,
  alreadyShownSignatures,
  startDigestRun,
  finishDigestRun,
  insertDigest,
  insertDigestItems,
  getJobSnapshots,
  deleteUserDigestForRun,
  hasSentDigestForRun,
  getLatestDigestForUser,
  markDigestConsidered,
} from "./digests";
export type {
  DigestRecipient,
  NewDigest,
  NewDigestItem,
  DigestItemSnapshot,
  DigestView,
} from "./digests";
// Email delivery — the render payload read + per-send / user-level delivery-state writes.
export {
  getDigestEmailPayload,
  recordDigestSent,
  recordDigestDeliveryOutcome,
  recordDigestSendFailure,
} from "./digests";
export type { DigestEmailPayload, DigestDeliveryOutcome } from "./digests";
// Pre-send liveness probe — the apply-URL read + dead-link drop.
export { getDigestApplyTargets, dropDigestItemsAndRecount } from "./digests";
export type { DigestApplyTarget } from "./digests";
// First writer/reader of health_alerts (cooldown page-once dedup over the health checker).
export { recordHealthAlert, shouldNotify, DEFAULT_HEALTH_ALERT_COOLDOWN_H } from "./health-alerts";
