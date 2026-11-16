/**
 * The snapshot's manifest: the one committed file. It states what the snapshot is (when and how the
 * jobs were chosen, counts per slice, source and flag, each model's id, host, width and spend) and
 * lists every object with its size and SHA-256, so a rebuild can prove it holds the same bytes.
 */
import { z } from "zod";

import { JOB_FLAGS, SLICES, SNAPSHOT_FORMAT, type SnapshotSlice } from "./format";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.int().nonnegative();

export const ManifestObjectSchema = z.strictObject({
  /** The object's path inside the snapshot; its bucket key is `bucketPrefix` + this. */
  path: z.string().min(1),
  bytes: count,
  sha256,
  /** Rows in the object: jobs, table rows, or vectors. */
  rows: count,
});
export type ManifestObject = z.infer<typeof ManifestObjectSchema>;

const SliceSchema = z.strictObject({
  /** How the slice's jobs were chosen: the SQL predicate, or the feeds and their filters. */
  selection: z.string().min(1),
  /** When they were read (the export transaction's clock, or the fetch time). */
  takenAt: z.iso.datetime(),
  jobs: count,
  /** Texts actually embedded: jobs carrying identical text share one vector. */
  uniqueTexts: count,
  bySource: z.record(z.string(), count),
  byFlag: z.strictObject(Object.fromEntries(JOB_FLAGS.map((f) => [f, count]))),
});
export type ManifestSlice = z.infer<typeof SliceSchema>;

const ModelSchema = z.strictObject({
  /** The id stored beside each vector. */
  id: z.string().min(1),
  slug: z.string().min(1),
  role: z.enum(["reference", "challenger"]),
  host: z.string().min(1),
  dimensions: z.int().positive(),
  /** How a job (document) and a profile (query) are presented to the model. */
  presentation: z.strictObject({ document: z.string(), query: z.string() }),
  pricePerMTokUsd: z.number().nonnegative(),
  /** Measured: every token the provider billed for this model's vectors, and its list-price cost. */
  tokens: count,
  usd: z.number().nonnegative(),
});
export type ManifestModel = z.infer<typeof ModelSchema>;

export const ManifestSchema = z.strictObject({
  format: z.literal(SNAPSHOT_FORMAT),
  id: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bucketPrefix: z.string().min(1),
  /** The shared input cap (UTF-16 code units) applied before any model saw a job's text. */
  textCapChars: z.int().positive(),
  slices: z.partialRecord(z.enum(SLICES), SliceSchema),
  tables: z.strictObject({ companies: count, "location-strings": count, places: count }),
  models: z.array(ModelSchema),
  objects: z.array(ManifestObjectSchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Parse and cross-check a manifest: beyond the shape, every count it states must agree with the
 * objects it lists, and every model must have a vectors part for every jobs part.
 */
export function parseManifest(value: unknown): Manifest {
  const parsed = ManifestSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`invalid snapshot manifest: ${z.prettifyError(parsed.error)}`);
  const manifest = parsed.data;

  const paths = new Set<string>();
  for (const object of manifest.objects) {
    if (paths.has(object.path)) throw new Error(`manifest lists ${object.path} twice.`);
    paths.add(object.path);
  }

  const rowsUnder = (prefix: string) =>
    manifest.objects.filter((o) => o.path.startsWith(prefix)).reduce((sum, o) => sum + o.rows, 0);
  const expect = (what: string, stated: number, listed: number) => {
    if (stated !== listed) {
      throw new Error(`manifest states ${stated} ${what} but its objects hold ${listed}.`);
    }
  };

  for (const [slice, def] of Object.entries(manifest.slices) as [SnapshotSlice, ManifestSlice][]) {
    expect(`${slice} jobs`, def.jobs, rowsUnder(`jobs/${slice}-`));
    for (const model of manifest.models) {
      expect(
        `${slice} ${model.slug} vectors`,
        def.jobs,
        rowsUnder(`vectors/${model.slug}/${slice}-`),
      );
    }
  }
  for (const [table, stated] of Object.entries(manifest.tables)) {
    expect(`${table} rows`, stated, rowsUnder(`${table}/`));
  }
  for (const model of manifest.models) {
    for (const object of manifest.objects.filter((o) =>
      o.path.startsWith(`vectors/${model.slug}/`),
    )) {
      if (object.bytes !== object.rows * model.dimensions * 4) {
        throw new Error(
          `${object.path}: ${object.bytes} bytes is not ${object.rows} vectors of ${model.dimensions} dims.`,
        );
      }
    }
  }
  return manifest;
}

/** The manifest as committed: stable key order, objects sorted by path, trailing newline. */
export function serializeManifest(manifest: Manifest): string {
  const sorted = {
    ...manifest,
    objects: [...manifest.objects].sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  return `${JSON.stringify(parseManifest(sorted), null, 2)}\n`;
}
