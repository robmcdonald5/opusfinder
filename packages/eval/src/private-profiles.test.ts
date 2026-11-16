import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { StructuredProfile } from "@opusfinder/shared";

import {
  addPrivateProfile,
  listPrivateProfiles,
  loadPrivateProfiles,
  PRIVATE_INDEX_KEY,
  removePrivateProfile,
  restructurePrivateProfiles,
  type CvExtraction,
  type ProfileStore,
} from "./private-profiles";
import {
  cvPdfPath,
  loadCvRegistry,
  loadProfileSet,
  PROFILE_SET_VERSION,
  profileContentHash,
  profilePath,
} from "./profile-set";

// A synthetic CV stands in for a real person's: the committed PDF and the profile extracted from it.
const STAND_IN = loadCvRegistry().find((cv) => cv.id === "syn-barista")!;
const PDF = readFileSync(cvPdfPath(STAND_IN));
const PROFILE = JSON.parse(
  readFileSync(profilePath(STAND_IN.id, PROFILE_SET_VERSION), "utf8"),
) as StructuredProfile;
const TRANSCRIPT = "Barista with 4+ years behind the bar in high-volume specialty cafés. ".repeat(
  3,
);

function memoryStore(): ProfileStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    putObject: async ({ key, body }) => {
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
    },
    getObject: async (key) => objects.get(key) ?? null,
    deleteObject: async (key) => {
      objects.delete(key);
    },
  };
}

const extraction: CvExtraction = {
  transcribe: async () => TRANSCRIPT,
  structure: async () => PROFILE,
};
const CV = {
  id: "tester-01",
  group: "hourly-shift" as const,
  pdf: PDF,
  consent: { by: "tester", on: "2026-11-16" },
};

describe("private test profiles", () => {
  it("stores the PDF, transcript and profile under profiles/<id>/, and loads like a committed profile", async () => {
    const store = memoryStore();
    const entry = await addPrivateProfile(store, CV, extraction);
    expect(entry).toEqual({
      id: "tester-01",
      group: "hourly-shift",
      sha256: STAND_IN.source.sha256,
      consent: CV.consent,
      versions: [2],
    });
    expect([...store.objects.keys()].sort()).toEqual([
      PRIVATE_INDEX_KEY,
      "profiles/tester-01/cv.pdf",
      "profiles/tester-01/transcript.txt",
      "profiles/tester-01/v2.json",
    ]);
    expect(store.objects.get("profiles/tester-01/cv.pdf")).toEqual(PDF);

    const loaded = await loadPrivateProfiles(store);
    const committed = loadProfileSet().find((p) => p.id === STAND_IN.id)!;
    expect(loaded).toEqual([
      {
        id: "tester-01",
        group: "hourly-shift",
        source: { private: true, sha256: STAND_IN.source.sha256 },
        profile: committed.profile,
        contentHash: committed.contentHash,
      },
    ]);
  });

  it("scrubs contact details the extraction let through", async () => {
    const store = memoryStore();
    const leaky = { ...PROFILE, summary: `${PROFILE.summary} Reach me at someone@example.com.` };
    await addPrivateProfile(store, CV, { ...extraction, structure: async () => leaky });
    const [loaded] = await loadPrivateProfiles(store);
    expect(loaded!.profile.summary).not.toContain("someone@example.com");
  });

  it("refuses an id a private or a committed profile already has", async () => {
    const store = memoryStore();
    await addPrivateProfile(store, CV, extraction);
    await expect(addPrivateProfile(store, CV, extraction)).rejects.toThrow(
      /already a test profile/,
    );
    await expect(
      addPrivateProfile(store, { ...CV, id: "syn-barista" }, extraction),
    ).rejects.toThrow(/already a test profile/);
  });

  it("leaves nothing a loader would see when the extraction fails", async () => {
    const store = memoryStore();
    const failing = { ...extraction, transcribe: async () => "too short" };
    await expect(addPrivateProfile(store, CV, failing)).rejects.toThrow(/transcript too short/);
    expect(store.objects.size).toBe(0);
    expect(await loadPrivateProfiles(store)).toEqual([]);
  });

  it("re-extracts from the stored transcript when the version moves", async () => {
    const store = memoryStore();
    await addPrivateProfile(store, CV, extraction);
    await expect(loadPrivateProfiles(store, 3)).rejects.toThrow(/v3\.json is missing/);

    const seen: string[] = [];
    const structure = async (transcript: string) => {
      seen.push(transcript);
      return { ...PROFILE, summary: "Barista and shift lead.", extractVersion: 3 };
    };
    expect(await restructurePrivateProfiles(store, structure, 3)).toEqual(["tester-01"]);
    expect(seen).toEqual([TRANSCRIPT]);
    expect(await restructurePrivateProfiles(store, structure, 3)).toEqual([]);

    const [v3] = await loadPrivateProfiles(store, 3);
    const [v2] = await loadPrivateProfiles(store, 2);
    expect(v3!.profile.extractVersion).toBe(3);
    expect(v3!.contentHash).not.toBe(v2!.contentHash);
    expect(v2!.contentHash).toBe(profileContentHash(PROFILE));
  });

  it("removes every object of a profile, and only that profile", async () => {
    const store = memoryStore();
    await addPrivateProfile(store, CV, extraction);
    await addPrivateProfile(store, { ...CV, id: "owner" }, extraction);
    expect(await removePrivateProfile(store, "tester-01")).toBe(true);
    expect(await removePrivateProfile(store, "tester-01")).toBe(false);
    expect([...store.objects.keys()].filter((key) => key.includes("tester-01"))).toEqual([]);
    expect((await listPrivateProfiles(store)).map((entry) => entry.id)).toEqual(["owner"]);
    expect(store.objects.has("profiles/owner/cv.pdf")).toBe(true);
  });
});
