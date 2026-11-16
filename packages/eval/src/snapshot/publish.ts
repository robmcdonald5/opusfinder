/**
 * Publishing a snapshot: describe the local objects in a manifest, upload them to the eval bucket,
 * and rebuilding one: download what the manifest lists and prove it is the same bytes.
 *
 * A published object never changes. Publishing again (to add the public slice, or a model) uploads
 * only what the committed manifest doesn't list yet, and refuses if a listed object differs locally.
 */
import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import type { StorageClient } from "@opusfinder/storage";

import {
  resolveSnapshotModel,
  isSnapshotModelSlug,
  type SnapshotModel,
} from "../embedders/snapshot-models";
import {
  embedRecordPath,
  modelSetup,
  modelSpend,
  planSlice,
  textsHash,
  type EmbedRecord,
} from "./embed-run";
import {
  bucketPrefix,
  decodeJsonl,
  JOB_FLAGS,
  sha256Hex,
  SLICES,
  sliceOfPart,
  SnapshotJobSchema,
  SNAPSHOT_FORMAT,
  TABLES,
  TEXT_CAP_CHARS,
  vectorsPartPath,
  type SnapshotSlice,
  type SnapshotTable,
} from "./format";
import type { Manifest, ManifestModel, ManifestObject, ManifestSlice } from "./manifest";
import { parseManifest } from "./manifest";
import { listJobsParts, listObjects, objectSize, readObject, writeObject } from "./store";

/** When and how a slice's jobs were chosen: written by the export or fetch, read at publish. */
export interface SliceRecord {
  selection: string;
  takenAt: string;
}

export interface BuildManifestInput {
  id: string;
  objectsDir: string;
  workDir: string;
  sliceRecords: Partial<Record<SnapshotSlice, SliceRecord>>;
  /** Test seam; defaults to the snapshot model catalog. */
  resolveModel?: (slug: string) => Promise<SnapshotModel>;
}

async function catalogModel(slug: string): Promise<SnapshotModel> {
  if (!isSnapshotModelSlug(slug)) throw new Error(`vectors/${slug}/ is not a snapshot model.`);
  return resolveSnapshotModel(slug);
}

/** Describe the local objects: every count is taken from the objects themselves. */
export async function buildManifest(input: BuildManifestInput): Promise<Manifest> {
  const { id, objectsDir, workDir } = input;
  const paths = listObjects(objectsDir);
  const objects: ManifestObject[] = [];
  const describe = (path: string, bytes: Uint8Array, rows: number) =>
    objects.push({ path, bytes: bytes.byteLength, sha256: sha256Hex(bytes), rows });

  const slices: Partial<Record<SnapshotSlice, ManifestSlice>> = {};
  const sliceTexts = new Map<SnapshotSlice, string>();
  for (const slice of SLICES) {
    const parts = listJobsParts(objectsDir, slice);
    if (parts.length === 0) continue;
    const record = input.sliceRecords[slice];
    if (!record)
      throw new Error(`no record of how the ${slice} slice was chosen (work/slice-${slice}.json).`);
    const plan = planSlice(objectsDir, slice);
    sliceTexts.set(slice, textsHash(plan));
    const def: ManifestSlice = {
      ...record,
      jobs: 0,
      uniqueTexts: plan.hashes.length,
      bySource: {},
      byFlag: Object.fromEntries(JOB_FLAGS.map((f) => [f, 0])),
    };
    for (const path of parts) {
      const bytes = readObject(objectsDir, path);
      const jobs = decodeJsonl(bytes, SnapshotJobSchema, path);
      describe(path, bytes, jobs.length);
      def.jobs += jobs.length;
      for (const job of jobs) {
        def.bySource[job.source] = (def.bySource[job.source] ?? 0) + 1;
        for (const flag of job.flags) def.byFlag[flag] = (def.byFlag[flag] ?? 0) + 1;
      }
    }
    slices[slice] = def;
  }

  const tables = { companies: 0, "location-strings": 0, places: 0 };
  for (const table of Object.keys(TABLES) as SnapshotTable[]) {
    for (const path of paths.filter((p) => p.startsWith(`${table}/`))) {
      const bytes = readObject(objectsDir, path);
      const rows = tableRows(table, bytes, path);
      describe(path, bytes, rows);
      tables[table] += rows;
    }
  }

  const resolveModel = input.resolveModel ?? catalogModel;
  const slugs = [
    ...new Set(paths.filter((p) => p.startsWith("vectors/")).map((p) => p.split("/")[1] as string)),
  ];
  const models: ManifestModel[] = [];
  for (const slug of slugs.sort()) {
    const model = await resolveModel(slug);
    // Its vectors must have been made from these jobs, by the model as it is set up now: a file of
    // the right size left over from another export, host or presentation is refused.
    for (const [slice, texts] of sliceTexts) {
      const expected: EmbedRecord = { ...modelSetup(model), textsHash: texts };
      const recordPath = embedRecordPath(workDir, slug, slice);
      const made = existsSync(recordPath) ? readFileSync(recordPath, "utf8") : null;
      if (made === null || !isDeepStrictEqual(JSON.parse(made), expected)) {
        throw new Error(
          `${slug} has no finished embed run for the ${slice} slice as it is now ` +
            `(${made === null ? "no record" : "its record names other jobs or another setup"}). ` +
            `Run snapshot:embed for it, or remove vectors/${slug}/ to publish without it.`,
        );
      }
    }
    // A model is in the snapshot only whole: a vectors part for every jobs part, of the right size.
    for (const jobsPart of objects
      .filter((o) => o.path.startsWith("jobs/"))
      .map((o) => ({ ...o }))) {
      const path = vectorsPartPath(slug, jobsPart.path);
      const expected = jobsPart.rows * model.dimensions * 4;
      if (objectSize(objectsDir, path) !== expected) {
        throw new Error(
          `${slug} is incomplete: ${path} should be ${expected} bytes (${jobsPart.rows} vectors). ` +
            `Finish its embed run, or remove vectors/${slug}/ to publish without it.`,
        );
      }
      describe(path, readObject(objectsDir, path), jobsPart.rows);
    }
    models.push({
      id: model.id,
      slug,
      role: model.role,
      host: model.host,
      dimensions: model.dimensions,
      presentation: model.presentation,
      pricePerMTokUsd: model.pricePerMTokUsd,
      ...modelSpend(workDir, slug),
    });
  }

  const described = new Set(objects.map((o) => o.path));
  const stray = paths.filter((p) => !described.has(p));
  if (stray.length > 0)
    throw new Error(`objects that belong to no part of the snapshot: ${stray.join(", ")}`);

  return parseManifest({
    format: SNAPSHOT_FORMAT,
    id,
    bucketPrefix: bucketPrefix(id),
    textCapChars: TEXT_CAP_CHARS,
    slices,
    tables,
    models,
    objects,
  });
}

/** A table part's row count, every row validated against the table's schema. */
function tableRows(table: SnapshotTable, bytes: Uint8Array, at: string): number {
  return decodeJsonl<unknown>(bytes, TABLES[table], at).length;
}

function contentType(path: string): string {
  return path.endsWith(".jsonl.gz") ? "application/gzip" : "application/octet-stream";
}

/**
 * Upload what `published` (the committed manifest, if any) doesn't already list. Returns the paths
 * uploaded. Refuses when an already-published object differs locally: a frozen snapshot isn't edited.
 */
export async function uploadSnapshot(
  manifest: Manifest,
  published: Manifest | null,
  objectsDir: string,
  store: StorageClient,
  log: (line: string) => void = () => {},
): Promise<string[]> {
  const before = new Map((published?.objects ?? []).map((o) => [o.path, o.sha256]));
  for (const object of manifest.objects) {
    const was = before.get(object.path);
    if (was !== undefined && was !== object.sha256) {
      throw new Error(
        `${object.path} is already published with different content; a published object never changes.`,
      );
    }
  }
  const gone = [...before.keys()].filter((p) => !manifest.objects.some((o) => o.path === p));
  if (gone.length > 0) throw new Error(`published objects are missing locally: ${gone.join(", ")}`);

  const uploaded: string[] = [];
  for (const object of manifest.objects) {
    if (before.has(object.path)) continue;
    await store.putObject({
      key: manifest.bucketPrefix + object.path,
      body: readObject(objectsDir, object.path),
      contentType: contentType(object.path),
    });
    uploaded.push(object.path);
    log(`  uploaded ${object.path} (${object.bytes} bytes)`);
  }
  return uploaded;
}

/**
 * Make `objectsDir` hold exactly what the manifest lists: keep a local object whose size and SHA-256
 * match, download the rest, and fail on the first object that is missing or differs.
 */
export async function downloadSnapshot(
  manifest: Manifest,
  objectsDir: string,
  store: StorageClient,
  log: (line: string) => void = () => {},
): Promise<{ kept: number; downloaded: number }> {
  let kept = 0;
  let downloaded = 0;
  for (const object of manifest.objects) {
    if (
      objectSize(objectsDir, object.path) === object.bytes &&
      sha256Hex(readObject(objectsDir, object.path)) === object.sha256
    ) {
      kept++;
      continue;
    }
    const key = manifest.bucketPrefix + object.path;
    const bytes = await store.getObject(key);
    if (bytes === null) throw new Error(`${key} is not in the bucket.`);
    assertMatches(object, bytes, `${key} (downloaded)`);
    writeObject(objectsDir, object.path, bytes);
    downloaded++;
    log(`  downloaded ${object.path}`);
  }
  return { kept, downloaded };
}

function assertMatches(object: ManifestObject, bytes: Uint8Array, at: string): void {
  const actual = sha256Hex(bytes);
  if (bytes.byteLength !== object.bytes || actual !== object.sha256) {
    throw new Error(
      `CHECKSUM MISMATCH for ${at}: manifest says ${object.bytes} bytes sha256 ${object.sha256}, ` +
        `got ${bytes.byteLength} bytes sha256 ${actual}.`,
    );
  }
}

export interface VerifiedSnapshot {
  jobs: number;
  objects: number;
  vectors: Record<string, number>;
}

/**
 * Load every object the manifest lists and check it is what the manifest says: bytes and SHA-256,
 * every row valid, job ids unique and ascending within a slice, and each vectors part as long as its
 * jobs part. Throws on the first difference.
 */
export function verifySnapshot(manifest: Manifest, objectsDir: string): VerifiedSnapshot {
  const rowsOf = new Map<string, number>();
  const seen = new Set<number>();
  const lastId = new Map<SnapshotSlice, number>();
  // In path order, so a slice's jobs parts are read in part order.
  for (const object of [...manifest.objects].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const size = objectSize(objectsDir, object.path);
    if (size === null) throw new Error(`${object.path} is missing locally; run snapshot:rebuild.`);
    const bytes = readObject(objectsDir, object.path);
    assertMatches(object, bytes, object.path);

    let rows: number;
    if (object.path.startsWith("jobs/")) {
      const jobs = decodeJsonl(bytes, SnapshotJobSchema, object.path);
      const slice = sliceOfPart(object.path);
      // Ascending across the slice's parts, not only within one.
      let last = lastId.get(slice) ?? -Infinity;
      for (const job of jobs) {
        if (job.slice !== slice)
          throw new Error(`${object.path}: job ${job.id} says slice ${job.slice}.`);
        if (job.id <= last || seen.has(job.id)) {
          throw new Error(`${object.path}: job id ${job.id} is out of order or repeated.`);
        }
        last = job.id;
        seen.add(job.id);
      }
      lastId.set(slice, last);
      rows = jobs.length;
    } else if (object.path.startsWith("vectors/")) {
      const model = manifest.models.find((m) => object.path.startsWith(`vectors/${m.slug}/`));
      if (!model) throw new Error(`${object.path}: no such model in the manifest.`);
      rows = bytes.byteLength / (model.dimensions * 4);
    } else {
      const table = object.path.split("/")[0] as SnapshotTable;
      if (!(table in TABLES)) throw new Error(`${object.path}: not a snapshot object.`);
      rows = tableRows(table, bytes, object.path);
    }
    if (rows !== object.rows) {
      throw new Error(
        `${object.path}: manifest says ${object.rows} rows, the object holds ${rows}.`,
      );
    }
    rowsOf.set(object.path, rows);
  }

  const vectors: Record<string, number> = {};
  for (const model of manifest.models) {
    vectors[model.slug] = 0;
    for (const [path, rows] of rowsOf) {
      if (!path.startsWith("jobs/")) continue;
      const part = vectorsPartPath(model.slug, path);
      if (rowsOf.get(part) !== rows) {
        throw new Error(
          `${part} does not line up with ${path} (${rowsOf.get(part) ?? "missing"} vs ${rows} rows).`,
        );
      }
      vectors[model.slug] = (vectors[model.slug] as number) + rows;
    }
  }
  return { jobs: seen.size, objects: manifest.objects.length, vectors };
}
