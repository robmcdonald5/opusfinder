/**
 * Test profiles from real people's CVs: the owner's and those of testers who agreed. Nothing of them
 * is committed, not the PDF, the transcript or the extracted profile; they live in the eval bucket
 * under `profiles/`, beside the job snapshot:
 *
 *   profiles/index.json            who is in the set: id, field group, the PDF's checksum, the consent
 *   profiles/<id>/cv.pdf           the CV as it was given
 *   profiles/<id>/transcript.txt   its transcript, so a new extraction version re-pays only the structuring call
 *   profiles/<id>/v<N>.json        the profile extraction version N produced
 *
 * An id is an opaque handle chosen at upload ("tester-03"), never a name: labels made against a private
 * profile are committed under that id and its content hash. Removing a profile deletes all of the above.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import {
  MIN_TRANSCRIPT_CHARS,
  profileEmbedText,
  profileExtractVersion,
  scrubProfilePii,
  type StructuredProfile,
} from "@opusfinder/shared";

import {
  CV_GROUPS,
  loadCvRegistry,
  parseStoredProfile,
  PROFILE_SET_VERSION,
  profileContentHash,
  type CvGroup,
  type ProfileSetEntry,
} from "./profile-set";

/** The object operations used here; `@opusfinder/storage`'s client for the eval bucket provides them. */
export interface ProfileStore {
  putObject(input: { key: string; body: Uint8Array | string; contentType: string }): Promise<void>;
  /** The object's bytes, or null if there is none. */
  getObject(key: string): Promise<Uint8Array | null>;
  deleteObject(key: string): Promise<void>;
}

/** The two production extraction calls, passed in so a test can stand in for them. */
export interface CvExtraction {
  transcribe(pdf: Uint8Array): Promise<string>;
  structure(transcript: string): Promise<StructuredProfile>;
}

export const PRIVATE_INDEX_KEY = "profiles/index.json";
export const privateCvKey = (id: string) => `profiles/${id}/cv.pdf`;
export const privateTranscriptKey = (id: string) => `profiles/${id}/transcript.txt`;
export const privateProfileKey = (id: string, version: number) => `profiles/${id}/v${version}.json`;

const PrivateEntrySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  group: z.enum(CV_GROUPS),
  /** SHA-256 of the PDF. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Who agreed to their CV being a test profile, and the day they did. */
  consent: z.strictObject({ by: z.string().min(1), on: z.iso.date() }),
  /** The extraction versions a profile is stored for. */
  versions: z.array(z.number().int()),
});
export type PrivateEntry = z.infer<typeof PrivateEntrySchema>;
const PrivateIndexSchema = z.strictObject({ profiles: z.array(PrivateEntrySchema) });

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Everyone in the private set, sorted by id. An absent index is an empty set. */
export async function listPrivateProfiles(store: ProfileStore): Promise<PrivateEntry[]> {
  const bytes = await store.getObject(PRIVATE_INDEX_KEY);
  if (!bytes) return [];
  const parsed = PrivateIndexSchema.safeParse(JSON.parse(decode(bytes)));
  if (!parsed.success) throw new Error(`${PRIVATE_INDEX_KEY}: ${z.prettifyError(parsed.error)}`);
  return parsed.data.profiles.sort((a, b) => a.id.localeCompare(b.id));
}

async function writeIndex(store: ProfileStore, profiles: PrivateEntry[]): Promise<void> {
  await store.putObject({
    key: PRIVATE_INDEX_KEY,
    body: json({ profiles }),
    contentType: "application/json",
  });
}

async function putProfile(store: ProfileStore, id: string, profile: StructuredProfile) {
  if (profileEmbedText(profile).length === 0)
    throw new Error(`${id}: the extracted profile has no summary, skills or target roles`);
  const version = profileExtractVersion(profile);
  await store.putObject({
    key: privateProfileKey(id, version),
    body: json(profile),
    contentType: "application/json",
  });
  return version;
}

/**
 * Add one person's CV to the private set: transcribe and structure it with the production calls, scrub
 * it, and store the PDF, the transcript and the profile. The index is written last, so a failed upload
 * leaves nothing a loader would see. Refuses an id already used by a private or a committed profile.
 */
export async function addPrivateProfile(
  store: ProfileStore,
  cv: { id: string; group: CvGroup; pdf: Uint8Array; consent: PrivateEntry["consent"] },
  extraction: CvExtraction,
  committedIds: readonly string[] = loadCvRegistry().map((entry) => entry.id),
): Promise<PrivateEntry> {
  const index = await listPrivateProfiles(store);
  if (index.some((entry) => entry.id === cv.id) || committedIds.includes(cv.id))
    throw new Error(`"${cv.id}" is already a test profile; choose another id`);

  const transcript = await extraction.transcribe(cv.pdf);
  if (transcript.trim().length < MIN_TRANSCRIPT_CHARS)
    throw new Error(`${cv.id}: transcript too short; a corrupt, encrypted or image-only PDF?`);
  const profile = scrubProfilePii(await extraction.structure(transcript));

  await store.putObject({ key: privateCvKey(cv.id), body: cv.pdf, contentType: "application/pdf" });
  await store.putObject({
    key: privateTranscriptKey(cv.id),
    body: transcript,
    contentType: "text/plain; charset=utf-8",
  });
  const version = await putProfile(store, cv.id, profile);
  const entry = PrivateEntrySchema.parse({
    id: cv.id,
    group: cv.group,
    sha256: createHash("sha256").update(cv.pdf).digest("hex"),
    consent: cv.consent,
    versions: [version],
  });
  await writeIndex(store, [...index, entry]);
  return entry;
}

/**
 * Re-extract, from its stored transcript, every private profile that has none at `version`. Run it
 * after the extraction version moves. Returns the ids it re-extracted.
 */
export async function restructurePrivateProfiles(
  store: ProfileStore,
  structure: CvExtraction["structure"],
  version: number,
): Promise<string[]> {
  const index = await listPrivateProfiles(store);
  const done: string[] = [];
  for (const entry of index.filter((e) => !e.versions.includes(version))) {
    const transcript = await store.getObject(privateTranscriptKey(entry.id));
    if (!transcript) throw new Error(`${privateTranscriptKey(entry.id)} is missing`);
    const profile = scrubProfilePii(await structure(decode(transcript)));
    if (profileExtractVersion(profile) !== version)
      throw new Error(
        `the extraction produced version ${profileExtractVersion(profile)}, not ${version}`,
      );
    await putProfile(store, entry.id, profile);
    entry.versions.push(version);
    done.push(entry.id);
  }
  if (done.length > 0) await writeIndex(store, index);
  return done;
}

/**
 * The private test profiles at one extraction version, in the same shape as the committed ones
 * (`loadProfileSet`). Throws if someone in the index has no profile at that version.
 */
export async function loadPrivateProfiles(
  store: ProfileStore,
  version = PROFILE_SET_VERSION,
): Promise<ProfileSetEntry[]> {
  const entries: ProfileSetEntry[] = [];
  for (const entry of await listPrivateProfiles(store)) {
    const key = privateProfileKey(entry.id, version);
    const bytes = await store.getObject(key);
    if (!bytes) throw new Error(`${key} is missing; run the re-extraction for version ${version}`);
    const profile = parseStoredProfile(JSON.parse(decode(bytes)), key);
    entries.push({
      id: entry.id,
      group: entry.group,
      source: { private: true, sha256: entry.sha256 },
      profile,
      contentHash: profileContentHash(profile),
    });
  }
  return entries;
}

/**
 * Delete one person from the private set: the index entry first, so no loader sees a half-deleted
 * profile, then the PDF, the transcript and every stored profile. Returns false if the id is not there.
 */
export async function removePrivateProfile(store: ProfileStore, id: string): Promise<boolean> {
  const index = await listPrivateProfiles(store);
  const entry = index.find((e) => e.id === id);
  if (!entry) return false;
  await writeIndex(
    store,
    index.filter((e) => e.id !== id),
  );
  await store.deleteObject(privateCvKey(id));
  await store.deleteObject(privateTranscriptKey(id));
  for (const version of entry.versions) await store.deleteObject(privateProfileKey(id, version));
  return true;
}
