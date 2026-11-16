/**
 * The eval's test profiles: one per CV in the registry (data/cv-extract/cvs.json), each the profile the
 * production extraction produced from that CV.
 *
 *   data/cv-extract/cvs.json         every CV: its id, field group and where the file comes from
 *   data/cv-extract/v<N>/<id>.json   the profile extraction version N produced from it
 *   data/cv-extract/synthetic/       the synthetic CVs themselves (HTML source + the PDF that is extracted)
 *
 * A CV is either a file in a public CC0 dataset, pinned to one commit and to its SHA-256 and downloaded
 * on demand (never committed: the dataset's anonymisation leaves a few names behind), or a synthetic CV
 * written for this set from a real job posting and committed. CVs of real people who agreed to be test
 * profiles are in neither place: they live in the eval bucket (./private-profiles.ts).
 *
 * `cv-extract fetch | run` (scripts/cv-extract.ts) downloads the CVs and extracts the profiles.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { CvProfileSchema } from "@opusfinder/llm";
import { profileExtractVersion, type StructuredProfile } from "@opusfinder/shared";

import { PKG_ROOT } from "./runner";

export const CV_GROUPS = ["healthcare-licensed", "hourly-shift", "other-non-tech", "tech"] as const;
export type CvGroup = (typeof CV_GROUPS)[number];

/**
 * The extraction version the test profiles are read at. Labels are keyed on a profile's content hash,
 * so moving this (after `cv-extract run` has filled the new version's directory) leaves every label
 * made so far pointing at the old profiles. It is deliberately not CV_EXTRACT_VERSION: a prompt change
 * in production must not re-key the eval by itself.
 */
export const PROFILE_SET_VERSION = 2;

export const CV_DATA_DIR = join(PKG_ROOT, "data", "cv-extract");
export const CV_REGISTRY = join(CV_DATA_DIR, "cvs.json");
export const SYNTHETIC_CVS_DIR = join(CV_DATA_DIR, "synthetic");
/** Downloaded dataset CVs and every CV's cached transcript. Gitignored. */
export const CV_DOWNLOADS_DIR = join(PKG_ROOT, "data", "cvs", "cv-extract");

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** A file in a public Hugging Face dataset, pinned to one commit of it and to the file's SHA-256, so
 *  every download is the same bytes. */
const DatasetCvSchema = z.strictObject({
  dataset: z.string(),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  path: z.string(),
  sha256,
});

/** The page layouts the synthetic CVs are set in. The dataset's CVs are all single-column. */
export const SYNTHETIC_LAYOUTS = ["sidebar-left", "sidebar-right", "two-column"] as const;

/**
 * A CV written for this set, describing nobody: data/cv-extract/synthetic/<id>.pdf, rendered from the
 * <id>.html beside it. `posting` is the real job posting its occupation, duties and requirements were
 * taken from, so a harness can tell when that posting (a near-certain match) is in its job pool.
 */
const SyntheticCvSchema = z.strictObject({
  synthetic: z.literal(true),
  layout: z.enum(SYNTHETIC_LAYOUTS),
  posting: z.strictObject({
    title: z.string().min(1),
    employer: z.string().min(1),
    url: z.url(),
    /** The day the posting was read, YYYY-MM-DD. */
    retrieved: z.iso.date(),
  }),
  sha256,
});

const CvSourceSchema = z.union([DatasetCvSchema, SyntheticCvSchema]);
export type DatasetCv = z.infer<typeof DatasetCvSchema>;
export type SyntheticCv = z.infer<typeof SyntheticCvSchema>;
export type CvSource = z.infer<typeof CvSourceSchema>;

const CvEntrySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  group: z.enum(CV_GROUPS),
  source: CvSourceSchema,
});
export type CvEntry = z.infer<typeof CvEntrySchema>;

export function isSynthetic(source: CvSource): source is SyntheticCv {
  return "synthetic" in source;
}

/** Where a dataset CV is downloaded from. */
export function datasetCvUrl(source: DatasetCv): string {
  return `https://huggingface.co/datasets/${source.dataset}/resolve/${source.revision}/${source.path}`;
}

/** The CV's PDF on disk: committed for a synthetic CV, downloaded by `cv-extract fetch` otherwise. */
export function cvPdfPath(cv: CvEntry): string {
  return join(isSynthetic(cv.source) ? SYNTHETIC_CVS_DIR : CV_DOWNLOADS_DIR, `${cv.id}.pdf`);
}

/** Every CV in the registry, sorted by id. Throws on a malformed entry or a repeated id. */
export function loadCvRegistry(file = CV_REGISTRY): CvEntry[] {
  const parsed = z.array(CvEntrySchema).safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
  const seen = new Set<string>();
  for (const cv of parsed.data) {
    if (seen.has(cv.id)) throw new Error(`${file}: "${cv.id}" is listed twice`);
    seen.add(cv.id);
  }
  return parsed.data.sort((a, b) => a.id.localeCompare(b.id));
}

/** A stored profile. `facts` and the version tag are absent on version-1 profiles. */
const StoredProfileSchema = CvProfileSchema.partial({ facts: true }).extend({
  extractVersion: z.number().int().optional(),
});

/** Parse a stored profile, naming `at` on failure. */
export function parseStoredProfile(value: unknown, at: string): StructuredProfile {
  const parsed = StoredProfileSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${at}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const fields = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The hash a label is keyed on: SHA-256 over the whole stored profile (the embedded fields, `facts` and
 * the version tag), with object keys in sorted order so formatting and key order do not matter. Any
 * change to what a judge or an embedder could read changes it.
 */
export function profileContentHash(profile: StructuredProfile): string {
  return createHash("sha256").update(canonicalJson(profile)).digest("hex");
}

/** One test profile. */
export interface ProfileSetEntry {
  /** Stable across re-extractions of the same CV. */
  id: string;
  group: CvGroup;
  source: CvSource | PrivateCv;
  profile: StructuredProfile;
  /** {@link profileContentHash} of `profile`. */
  contentHash: string;
}

/** A real person's CV, held in the eval bucket only; the checksum is all that is said about it here. */
export interface PrivateCv {
  private: true;
  sha256: string;
}

export function profilePath(id: string, version: number, dataDir = CV_DATA_DIR): string {
  return join(dataDir, `v${version}`, `${id}.json`);
}

/**
 * Every committed test profile at one extraction version, sorted by id. Throws if a CV in the registry
 * has no profile at that version (run `cv-extract run`), or a file there carries another version's tag.
 */
export function loadProfileSet(
  version = PROFILE_SET_VERSION,
  dataDir = CV_DATA_DIR,
): ProfileSetEntry[] {
  const cvs = loadCvRegistry(join(dataDir, "cvs.json"));
  const missing = cvs.filter((cv) => !existsSync(profilePath(cv.id, version, dataDir)));
  if (missing.length > 0) {
    throw new Error(
      `no version-${version} profile for: ${missing.map((cv) => cv.id).join(", ")}. Run \`cv-extract run\`.`,
    );
  }
  return cvs.map((cv) => {
    const file = profilePath(cv.id, version, dataDir);
    const profile = parseStoredProfile(JSON.parse(readFileSync(file, "utf8")), file);
    if (profileExtractVersion(profile) !== version) {
      throw new Error(`${file}: tagged version ${profileExtractVersion(profile)}, not ${version}`);
    }
    return { ...cv, profile, contentHash: profileContentHash(profile) };
  });
}

/** How many profiles each group holds. */
export function countByGroup(entries: readonly { group: CvGroup }[]): Record<CvGroup, number> {
  const counts = Object.fromEntries(CV_GROUPS.map((g) => [g, 0])) as Record<CvGroup, number>;
  for (const entry of entries) counts[entry.group] += 1;
  return counts;
}
