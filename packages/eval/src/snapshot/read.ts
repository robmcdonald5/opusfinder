/**
 * Reading a rebuilt snapshot: its jobs, the tables beside them, each model's vectors, and a loader
 * that puts the jobs and tables into a database with production's schema, so production's own
 * location rule and filters can run over the frozen set.
 *
 * `snapshot:rebuild` is what proves the local objects match the manifest; this trusts them.
 */
import { readFileSync } from "node:fs";

import type { z } from "zod";

import type { Db } from "@opusfinder/db";
import { companies, jobs, locationStrings, places } from "@opusfinder/db/schema";

import {
  decodeJsonl,
  decodeVectors,
  SLICES,
  sliceOfPart,
  TABLES,
  truncateVector,
  vectorsPartPath,
  type SnapshotJob,
  type SnapshotSlice,
  type SnapshotTable,
} from "./format";
import { parseManifest, type Manifest } from "./manifest";
import { readJobsPart, readObject, snapshotPaths, SNAPSHOTS_DIR } from "./store";

export interface SnapshotVectors {
  /** The model's id, as stored beside a production vector. */
  model: string;
  dimensions: number;
  /** Job ids, in the order of the matrix's rows (the order `jobs()` yields). */
  jobIds: number[];
  /** Row i is `matrix.subarray(i * dimensions, (i + 1) * dimensions)`. */
  matrix: Float32Array;
}

export interface Snapshot {
  manifest: Manifest;
  /** Every job, slice by slice (ats, then public), ordered by id within a slice. */
  jobs(slice?: SnapshotSlice): Generator<SnapshotJob>;
  table<T extends SnapshotTable>(table: T): z.infer<(typeof TABLES)[T]>[];
  /**
   * One model's vectors for every job. `width` cuts each vector to its first components and
   * re-normalises it (how a 4096-wide model is compared at 1024); omitted = the stored width.
   */
  vectors(modelSlug: string, opts?: { width?: number }): SnapshotVectors;
}

export function openSnapshot(id: string, snapshotsDir = SNAPSHOTS_DIR): Snapshot {
  const paths = snapshotPaths(id, snapshotsDir);
  const manifest = parseManifest(JSON.parse(readFileSync(paths.manifest, "utf8")));
  const jobsParts = (slice?: SnapshotSlice) =>
    SLICES.filter((s) => slice === undefined || s === slice).flatMap((s) =>
      manifest.objects
        .map((o) => o.path)
        .filter((p) => p.startsWith("jobs/") && sliceOfPart(p) === s)
        .sort(),
    );

  return {
    manifest,
    *jobs(slice) {
      for (const path of jobsParts(slice)) yield* readJobsPart(paths.objects, path);
    },
    table(table) {
      return manifest.objects
        .map((o) => o.path)
        .filter((p) => p.startsWith(`${table}/`))
        .sort()
        .flatMap((p) =>
          decodeJsonl(readObject(paths.objects, p), TABLES[table] as z.ZodType, p),
        ) as never;
    },
    vectors(modelSlug, opts = {}) {
      const model = manifest.models.find((m) => m.slug === modelSlug);
      if (!model) {
        throw new Error(
          `snapshot ${id} has no model "${modelSlug}" (it has: ${manifest.models.map((m) => m.slug).join(", ")}).`,
        );
      }
      const width = opts.width ?? model.dimensions;
      const jobIds: number[] = [];
      const blocks: Float32Array[] = [];
      for (const path of jobsParts()) {
        for (const job of readJobsPart(paths.objects, path)) jobIds.push(job.id);
        const part = vectorsPartPath(modelSlug, path);
        const full = decodeVectors(readObject(paths.objects, part), model.dimensions, part);
        if (width === model.dimensions) {
          blocks.push(full);
          continue;
        }
        const rows = full.length / model.dimensions;
        const cut = new Float32Array(rows * width);
        for (let r = 0; r < rows; r++) {
          cut.set(
            truncateVector(full.subarray(r * model.dimensions, (r + 1) * model.dimensions), width),
            r * width,
          );
        }
        blocks.push(cut);
      }
      const matrix = new Float32Array(jobIds.length * width);
      let offset = 0;
      for (const block of blocks) {
        matrix.set(block, offset);
        offset += block.length;
      }
      return { model: model.id, dimensions: width, jobIds, matrix };
    },
  };
}

const INSERT_BATCH = 500;

async function inBatches<T>(rows: T[], insert: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) await insert(rows.slice(i, i + INSERT_BATCH));
}

/**
 * Load the snapshot's jobs, companies, location strings and places into an EMPTY database with
 * production's schema (a local PGlite), keeping every id. Jobs arrive active and with no vector:
 * ranking uses `vectors()`, since the snapshot's models don't share the column's width. Filters that
 * compare against `now()` (recency) must instead use the slice's `takenAt`, the moment the snapshot
 * froze.
 */
export async function loadSnapshotIntoDb(db: Db, snapshot: Snapshot): Promise<void> {
  await inBatches(snapshot.table("companies"), (batch) =>
    db.insert(companies).values(
      batch.map((c) => ({
        id: c.id,
        slug: c.slug,
        source: c.source,
        metadata: c.name === null ? null : { name: c.name },
      })) as (typeof companies.$inferInsert)[],
    ),
  );
  await inBatches(snapshot.table("places"), (batch) =>
    db.insert(places).values(batch as (typeof places.$inferInsert)[]),
  );
  await inBatches(snapshot.table("location-strings"), (batch) =>
    db.insert(locationStrings).values(batch as (typeof locationStrings.$inferInsert)[]),
  );
  await inBatches([...snapshot.jobs()], (batch) =>
    db.insert(jobs).values(
      batch.map((j) => ({
        id: j.id,
        externalId: j.externalId,
        companyId: j.companyId,
        source: j.source,
        title: j.title,
        descriptionText: j.descriptionText,
        locations: j.locations,
        remote: j.remote,
        applyUrl: j.applyUrl,
        postedAt: j.postedAt === null ? null : new Date(j.postedAt),
        createdAt: new Date(j.createdAt),
        lastSeenAt: new Date(j.lastSeenAt),
        contentSignature: j.contentSignature,
      })) as (typeof jobs.$inferInsert)[],
    ),
  );
}
