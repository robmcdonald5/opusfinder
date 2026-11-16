import { describe, expect, it, vi } from "vitest";

import type { Db } from "@opusfinder/db";
import { upsertUserProfile } from "@opusfinder/db/repos";
import { MIN_TRANSCRIPT_CHARS, type StructuredProfile } from "@opusfinder/shared";
import type { StorageClient } from "@opusfinder/storage";

import { uid } from "@test/db/ids";
import { EMBED_ONLY_LINE } from "@test/profile-text-variants";

import { ingestCv } from "./ingest";
import { restructureProfile } from "./restructure";
import type { ProfileEmbedFn } from "./types";

// The profile's vector is built from the embedded text alone. Here the two profile texts are made to
// differ (each gains a line of its own), and the embedder must receive the embedded variant with no
// trace of the judge's: a line added to what the judge reads never changes a vector's input. The
// repos are stubbed, so no database is needed; the persistence itself is covered by the integration
// suites next to this file.
vi.mock("@opusfinder/shared", async (importOriginal) => {
  const { withDivergedProfileTexts } = await import("@test/profile-text-variants");
  return withDivergedProfileTexts(await importOriginal<typeof import("@opusfinder/shared")>());
});

vi.mock("@opusfinder/db/repos", () => ({
  insertCvFile: vi.fn(async () => ({ id: 1 })),
  patchCvFileExtracted: vi.fn(async () => undefined),
  markCvFileFailed: vi.fn(async () => undefined),
  getProfileTextKey: vi.fn(async () => ({ sourceCvFileId: 1, r2TextKey: "text/u/t.txt" })),
  upsertUserProfile: vi.fn(async () => ({ id: 1 })),
}));

const PROFILE: StructuredProfile = {
  summary: "Registered nurse with 8 years in acute medical-surgical care.",
  skills: ["Patient assessment", "IV therapy", "Epic"],
  targetRoles: ["Charge Nurse", "Clinical Nurse Educator"],
};
// Hand-written: the text embedded today, then the line only the embedded variant adds.
const EXPECTED_EMBED_INPUT =
  "Registered nurse with 8 years in acute medical-surgical care.\n\n" +
  "Skills: Patient assessment, IV therapy, Epic\n\n" +
  "Target roles: Charge Nurse, Clinical Nurse Educator\n\n" +
  EMBED_ONLY_LINE;

const VECTOR = [0.25, 0.5];
const TRANSCRIPT = "t".repeat(MIN_TRANSCRIPT_CHARS);
const NO_DB = {} as Db;

function stubEmbed() {
  return vi.fn<ProfileEmbedFn>(async (texts) => ({
    embeddings: texts.map(() => VECTOR),
    usage: { totalTokens: 1 },
    model: "test-model",
  }));
}

const storage: StorageClient = {
  async putObject() {},
  async getObject() {
    return new TextEncoder().encode(TRANSCRIPT);
  },
  async deleteObject() {},
  close() {},
};

describe("the profile vector's input", () => {
  it("ingestCv embeds the embedded text, and stores the vector made from it", async () => {
    const embed = stubEmbed();

    await ingestCv(NO_DB, {
      userId: uid(1),
      bytes: new Uint8Array([1]),
      filename: "cv.pdf",
      contentType: "application/pdf",
      transcribe: async () => TRANSCRIPT,
      structure: async () => PROFILE,
      embed,
      storage,
    });

    expect(embed).toHaveBeenCalledExactlyOnceWith([EXPECTED_EMBED_INPUT], { inputType: "query" });
    expect(vi.mocked(upsertUserProfile)).toHaveBeenLastCalledWith(
      NO_DB,
      expect.objectContaining({ structured: PROFILE, embedding: VECTOR }),
    );
  });

  it("restructureProfile embeds the embedded text", async () => {
    const embed = stubEmbed();

    await restructureProfile(NO_DB, { structure: async () => PROFILE, embed, storage }, uid(1));

    expect(embed).toHaveBeenCalledExactlyOnceWith([EXPECTED_EMBED_INPUT], { inputType: "query" });
  });
});
