/**
 * The frozen job snapshot's on-disk format: one fixed set of jobs every eval arm runs on, with each
 * job's vector from every snapshot model. The same files live in R2 (private) and, once rebuilt,
 * under data/snapshots/<id>/objects/; only the manifest (./manifest.ts) is committed.
 *
 *   jobs/<slice>-NNNN.jsonl.gz              SnapshotJob per line, ordered by id
 *   companies/part-NNNN.jsonl.gz            SnapshotCompany
 *   location-strings/part-NNNN.jsonl.gz     SnapshotLocationString (production's resolved places)
 *   places/part-NNNN.jsonl.gz               SnapshotPlace (the gazetteer the place ids point into)
 *   vectors/<model slug>/<slice>-NNNN.f32   float32 LE, row i = the vector of row i of jobs/<slice>-NNNN
 *
 * The three tables beside the jobs are what production's location rule reads, so a harness can load
 * them (./read.ts) and apply a user's preferences with the production SQL.
 */
import { createHash } from "node:crypto";
import { endianness } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";

import { z } from "zod";

import { jobEmbeddingText } from "@opusfinder/db/repos";

export const SNAPSHOT_FORMAT = 1;

/** `ats` = production's active jobs at export time; `public` = the one-off US public-sector fetch. */
export const SLICES = ["ats", "public"] as const;
export type SnapshotSlice = (typeof SLICES)[number];

/** Ids for rows that never existed in production (the public slice's jobs and employers) start here,
 *  far above any serial id production will reach. */
export const SYNTHETIC_ID_BASE = 1_000_000_000;

/** Rows per jobs part, and so per vectors part (41 MB at 4096 dims). */
export const JOBS_PER_PART = 2_500;
export const TABLE_ROWS_PER_PART = 50_000;

/**
 * The one length cap every model's input shares, in UTF-16 code units. All three snapshot models
 * accept 32k tokens per input; even text that tokenizes at 2 characters a token stays under that here,
 * so no host truncates on its own and every model embeds identical text.
 */
export const TEXT_CAP_CHARS = 60_000;

/** A description shorter than this (but not blank) is flagged; the job is kept and embedded. */
export const SHORT_DESCRIPTION_CHARS = 200;

/**
 * Why a posting may be junk. Flags never drop a job: every job in the snapshot is embedded, and a
 * harness chooses what to do with flagged ones.
 *  - blank_description: nothing but whitespace (its text is the title alone);
 *  - short_description: under SHORT_DESCRIPTION_CHARS;
 *  - short_title: fewer than two letters or digits ("d", "-");
 *  - capped: the embedded text was cut at TEXT_CAP_CHARS.
 */
export const JOB_FLAGS = [
  "blank_description",
  "short_description",
  "short_title",
  "capped",
] as const;
export type JobFlag = (typeof JOB_FLAGS)[number];

const isoDate = z.iso.datetime();

export const SnapshotJobSchema = z.strictObject({
  id: z.int(),
  slice: z.enum(SLICES),
  source: z.string().min(1),
  externalId: z.string().min(1),
  companyId: z.int(),
  title: z.string(),
  descriptionText: z.string(),
  locations: z.array(z.string()),
  remote: z.boolean(),
  applyUrl: z.string(),
  postedAt: isoDate.nullable(),
  /** When production first stored the posting (the public slice: when it was fetched). */
  createdAt: isoDate,
  lastSeenAt: isoDate,
  contentSignature: z.string().nullable(),
  /** The model production had embedded this job with at export time, if any. Provenance only: every
   *  snapshot vector is embedded fresh. */
  productionEmbeddingModel: z.string().nullable(),
  flags: z.array(z.enum(JOB_FLAGS)),
});
export type SnapshotJob = z.infer<typeof SnapshotJobSchema>;

export const SnapshotCompanySchema = z.strictObject({
  id: z.int(),
  slug: z.string().min(1),
  source: z.string().min(1),
  name: z.string().nullable(),
});
export type SnapshotCompany = z.infer<typeof SnapshotCompanySchema>;

export const SnapshotLocationStringSchema = z.strictObject({
  companyId: z.int(),
  raw: z.string(),
  placeIds: z.array(z.int()),
  remoteCountries: z.array(z.string()),
  unmatched: z.array(z.unknown()),
  confidence: z.string().nullable(),
  reason: z.string().nullable(),
  promptVersion: z.string(),
});
export type SnapshotLocationString = z.infer<typeof SnapshotLocationStringSchema>;

export const SnapshotPlaceSchema = z.strictObject({
  geonamesId: z.int(),
  kind: z.string().min(1),
  name: z.string(),
  nameNorm: z.string(),
  asciiNorm: z.string(),
  altNames: z.array(z.string()),
  regionCode: z.string().nullable(),
  regionName: z.string().nullable(),
  countryCode: z.string(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  population: z.int().nullable(),
  source: z.string().min(1),
});
export type SnapshotPlace = z.infer<typeof SnapshotPlaceSchema>;

/** The tables stored beside the jobs, by their object-path prefix. */
export const TABLES = {
  companies: SnapshotCompanySchema,
  "location-strings": SnapshotLocationStringSchema,
  places: SnapshotPlaceSchema,
} as const;
export type SnapshotTable = keyof typeof TABLES;

const partNumber = (n: number): string => String(n).padStart(4, "0");

export function jobsPartPath(slice: SnapshotSlice, part: number): string {
  return `jobs/${slice}-${partNumber(part)}.jsonl.gz`;
}

/** A table part. `group` keeps a later slice's rows in parts of their own (`public-0000`), so adding
 *  that slice never rewrites a part already published. */
export function tablePartPath(table: SnapshotTable, part: number, group = "part"): string {
  return `${table}/${group}-${partNumber(part)}.jsonl.gz`;
}

/** The vectors part aligned to a jobs part: same slice and number, under the model's slug. */
export function vectorsPartPath(modelSlug: string, jobsPart: string): string {
  const name = /^jobs\/([a-z]+-\d{4})\.jsonl\.gz$/.exec(jobsPart)?.[1];
  if (!name) throw new Error(`not a jobs part: ${jobsPart}`);
  return `vectors/${modelSlug}/${name}.f32`;
}

/** The slice a jobs or vectors part belongs to, from its path. */
export function sliceOfPart(path: string): SnapshotSlice {
  const slice = /\/([a-z]+)-\d{4}\.[a-z0-9.]+$/.exec(path)?.[1];
  if (!SLICES.includes(slice as SnapshotSlice)) throw new Error(`no slice in part path: ${path}`);
  return slice as SnapshotSlice;
}

/** Where a snapshot's objects live in the eval bucket. `profiles/` beside it is left for private
 *  test profiles. */
export function bucketPrefix(snapshotId: string): string {
  return `jobs/${snapshotId}/`;
}

/**
 * The text every snapshot model embeds for a job: production's composition, cut at the shared cap.
 * A cut never splits a surrogate pair.
 */
export function snapshotEmbedText(job: { title: string; descriptionText: string }): {
  text: string;
  capped: boolean;
} {
  const full = jobEmbeddingText(job);
  if (full.length <= TEXT_CAP_CHARS) return { text: full, capped: false };
  const last = full.charCodeAt(TEXT_CAP_CHARS - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? TEXT_CAP_CHARS - 1 : TEXT_CAP_CHARS;
  return { text: full.slice(0, end), capped: true };
}

/** The junk flags for a job, in JOB_FLAGS order. */
export function jobFlags(job: { title: string; descriptionText: string }): JobFlag[] {
  const flags: JobFlag[] = [];
  const description = job.descriptionText.trim();
  if (description === "") flags.push("blank_description");
  else if (description.length < SHORT_DESCRIPTION_CHARS) flags.push("short_description");
  if ((job.title.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < 2) flags.push("short_title");
  if (snapshotEmbedText(job).capped) flags.push("capped");
  return flags;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Rows as gzipped JSON lines. mtime is zlib's default 0, so equal rows give equal bytes. */
export function encodeJsonl(rows: readonly unknown[]): Uint8Array {
  return gzipSync(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

/** Parse gzipped JSON lines, validating every row; `at` names the object in an error. */
export function decodeJsonl<T>(bytes: Uint8Array, schema: z.ZodType<T>, at: string): T[] {
  const lines = gunzipSync(bytes).toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, i) => {
    const parsed = schema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(`${at} line ${i + 1}: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  });
}

function assertLittleEndian(): void {
  if (endianness() !== "LE") throw new Error("snapshot vectors are little-endian float32.");
}

/** Vectors as one float32 LE block, row after row. Every row must be `dimensions` wide and finite. */
export function encodeVectors(rows: readonly ArrayLike<number>[], dimensions: number): Uint8Array {
  assertLittleEndian();
  const out = new Float32Array(rows.length * dimensions);
  rows.forEach((row, i) => {
    if (row.length !== dimensions) {
      throw new Error(`vector ${i} has ${row.length} dims; expected ${dimensions}.`);
    }
    for (let d = 0; d < dimensions; d++) {
      const x = row[d] as number;
      if (!Number.isFinite(x)) throw new Error(`vector ${i} has a non-finite component.`);
      out[i * dimensions + d] = x;
    }
  });
  return new Uint8Array(out.buffer);
}

/** The float32 block back as one matrix; row i is `subarray(i * dimensions, (i + 1) * dimensions)`. */
export function decodeVectors(bytes: Uint8Array, dimensions: number, at: string): Float32Array {
  assertLittleEndian();
  if (bytes.byteLength % (dimensions * 4) !== 0) {
    throw new Error(
      `${at}: ${bytes.byteLength} bytes is not a whole number of ${dimensions}-dim rows.`,
    );
  }
  // Copy into a buffer of its own: a file read is a view into Node's shared pool, at an offset that
  // isn't guaranteed to be 4-byte aligned (and Buffer.slice would only make another view).
  return new Float32Array(new Uint8Array(bytes).buffer);
}

/**
 * A vector cut to its first `width` components and re-normalised to unit length: how the snapshot's
 * 4096-wide models are compared at a narrower width without embedding again.
 */
export function truncateVector(vector: ArrayLike<number>, width: number): Float32Array {
  if (width > vector.length)
    throw new Error(`cannot widen a ${vector.length}-dim vector to ${width}.`);
  const out = new Float32Array(width);
  let sumSquares = 0;
  for (let d = 0; d < width; d++) {
    out[d] = vector[d] as number;
    sumSquares += (out[d] as number) ** 2;
  }
  const norm = Math.sqrt(sumSquares);
  if (norm > 0) for (let d = 0; d < width; d++) out[d] = (out[d] as number) / norm;
  return out;
}
