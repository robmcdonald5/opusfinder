// Public surface of @opusfinder/db/repos — the persistence layer over the
// Drizzle schema. Imported by ingestion scripts (and later Workers) to write
// normalized jobs through to Neon.
export { upsertCompany, upsertJobs, listCompanies } from "./jobs";
export type { CompanyRow } from "./jobs";
export {
  jobsNeedingEmbedding,
  writeJobEmbeddings,
  backfillJobEmbeddings,
  nearestJobs,
  jobEmbeddingText,
} from "./embeddings";
export type { JobNeedingEmbedding, JobNeighbor } from "./embeddings";
