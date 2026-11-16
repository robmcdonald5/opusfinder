/**
 * The production slice of a snapshot: every job that is active at one moment, with the tables
 * production's location rule reads (the jobs' companies, the resolved location strings, the places).
 *
 * READ-ONLY: everything is read inside one REPEATABLE READ, READ ONLY transaction, so the objects are
 * one consistent moment of the database and the session cannot write.
 */
import {
  encodeJsonl,
  JOB_FLAGS,
  jobFlags,
  JOBS_PER_PART,
  jobsPartPath,
  SnapshotCompanySchema,
  SnapshotJobSchema,
  SnapshotLocationStringSchema,
  SnapshotPlaceSchema,
  TABLE_ROWS_PER_PART,
  tablePartPath,
  type JobFlag,
  type SnapshotJob,
  type SnapshotTable,
} from "./format";
import { writeObject } from "./store";

/** What the slice is, word for word in the manifest. */
export const ATS_SELECTION =
  "jobs.lifecycle_state = 'active' (every source, any age, embedded or not)";

type Row = Record<string, unknown>;

/** One database session: a pooled client, so every query runs on the same connection. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

export interface ExportResult {
  /** The transaction's clock: the moment the snapshot shows. */
  takenAt: string;
  jobs: number;
  bySource: Record<string, number>;
  byFlag: Record<JobFlag, number>;
  tables: Record<SnapshotTable, number>;
}

// The driver returns timestamptz as a Date (or, from some, an ISO-parseable string).
const iso = (value: unknown): string => new Date(value as string | Date).toISOString();
const isoOrNull = (value: unknown): string | null => (value === null ? null : iso(value));

function jobFromRow(r: Row): SnapshotJob {
  const text = { title: r.title as string, descriptionText: r.description_text as string };
  return SnapshotJobSchema.parse({
    id: r.id,
    slice: "ats",
    source: r.source,
    externalId: r.external_id,
    companyId: r.company_id,
    ...text,
    locations: Array.isArray(r.locations) ? r.locations.map(String) : [],
    remote: r.remote,
    applyUrl: r.apply_url,
    postedAt: isoOrNull(r.posted_at),
    createdAt: iso(r.created_at),
    lastSeenAt: iso(r.last_seen_at),
    contentSignature: r.content_signature,
    productionEmbeddingModel: r.embedding_model,
    flags: jobFlags(text),
  });
}

function writeTable(objectsDir: string, table: SnapshotTable, rows: unknown[]): number {
  for (let part = 0; part * TABLE_ROWS_PER_PART < rows.length; part++) {
    const page = rows.slice(part * TABLE_ROWS_PER_PART, (part + 1) * TABLE_ROWS_PER_PART);
    writeObject(objectsDir, tablePartPath(table, part), encodeJsonl(page));
  }
  return rows.length;
}

/**
 * Read the slice and write its objects under `objectsDir`. `onStart` gets the transaction's clock
 * before anything is written (the caller names the snapshot after its date).
 */
export async function exportProductionSlice(
  db: Queryable,
  objectsDirFor: (takenAt: string) => string,
  log: (line: string) => void = () => {},
): Promise<ExportResult> {
  await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  try {
    const clock = (
      await db.query("SELECT now() AS at, current_setting('transaction_read_only') AS ro")
    ).rows[0] as Row;
    if (clock.ro !== "on")
      throw new Error("the export transaction is not read-only; refusing to run.");
    const takenAt = iso(clock.at);
    const objectsDir = objectsDirFor(takenAt);

    const bySource: Record<string, number> = {};
    const byFlag = Object.fromEntries(JOB_FLAGS.map((f) => [f, 0])) as Record<JobFlag, number>;
    let jobs = 0;
    for (let part = 0, lastId = 0; ; part++) {
      const { rows } = await db.query(
        `SELECT id, external_id, company_id, source, title, description_text, locations, remote,
                apply_url, posted_at, created_at, last_seen_at, content_signature, embedding_model
         FROM jobs WHERE lifecycle_state = 'active' AND id > $1 ORDER BY id LIMIT $2`,
        [lastId, JOBS_PER_PART],
      );
      if (rows.length === 0) break;
      const page = rows.map(jobFromRow);
      writeObject(objectsDir, jobsPartPath("ats", part), encodeJsonl(page));
      for (const job of page) {
        bySource[job.source] = (bySource[job.source] ?? 0) + 1;
        for (const flag of job.flags) byFlag[flag]++;
      }
      jobs += page.length;
      lastId = (page.at(-1) as SnapshotJob).id;
      log(`  jobs: ${jobs}`);
    }

    const companies = (
      await db.query(
        `SELECT c.id, c.slug, c.source, c.metadata->>'name' AS name FROM companies c
         WHERE c.id IN (SELECT company_id FROM jobs WHERE lifecycle_state = 'active') ORDER BY c.id`,
      )
    ).rows.map((r) => SnapshotCompanySchema.parse(r));

    const locationStrings = (
      await db.query(
        `SELECT company_id, raw, place_ids, remote_countries, unmatched, confidence, reason, prompt_version
         FROM location_strings ORDER BY company_id, raw`,
      )
    ).rows.map((r) =>
      SnapshotLocationStringSchema.parse({
        companyId: r.company_id,
        raw: r.raw,
        placeIds: r.place_ids,
        remoteCountries: r.remote_countries,
        unmatched: r.unmatched,
        confidence: r.confidence,
        reason: r.reason,
        promptVersion: r.prompt_version,
      }),
    );

    const places: unknown[] = [];
    for (let lastId = 0; ; ) {
      const { rows } = await db.query(
        `SELECT geonames_id, kind, name, name_norm, ascii_norm, alt_names, region_code, region_name,
                country_code, lat, lng, population, source
         FROM places WHERE geonames_id > $1 ORDER BY geonames_id LIMIT $2`,
        [lastId, TABLE_ROWS_PER_PART],
      );
      if (rows.length === 0) break;
      for (const r of rows) {
        places.push(
          SnapshotPlaceSchema.parse({
            geonamesId: r.geonames_id,
            kind: r.kind,
            name: r.name,
            nameNorm: r.name_norm,
            asciiNorm: r.ascii_norm,
            altNames: r.alt_names,
            regionCode: r.region_code,
            regionName: r.region_name,
            countryCode: r.country_code,
            lat: r.lat,
            lng: r.lng,
            population: r.population,
            source: r.source,
          }),
        );
      }
      lastId = (rows.at(-1) as Row).geonames_id as number;
      log(`  places: ${places.length}`);
    }
    await db.query("COMMIT");

    const tables = {
      companies: writeTable(objectsDir, "companies", companies),
      "location-strings": writeTable(objectsDir, "location-strings", locationStrings),
      places: writeTable(objectsDir, "places", places),
    };
    return { takenAt, jobs, bySource, byFlag, tables };
  } catch (err) {
    // Nothing to undo in a read-only transaction; this only frees the session.
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
