// Public surface of @opusfinder/db/repos — the persistence layer over the
// Drizzle schema. Imported by ingestion scripts (and later Workers) to write
// normalized jobs through to Neon.
export { upsertCompany, upsertJobs } from "./jobs";
