import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeModel, memoryStore, snapshotJob, writeJobsParts } from "@test/eval/snapshot";

import { embedSlice } from "./embed-run";
import { encodeJsonl, tablePartPath } from "./format";
import { parseManifest, serializeManifest, type Manifest } from "./manifest";
import { buildManifest, downloadSnapshot, uploadSnapshot, verifySnapshot } from "./publish";
import { readObject, writeObject } from "./store";

// Publish → rebuild over a local folder, an offline model and an in-memory bucket: the manifest
// describes exactly what was uploaded, a clean folder rebuilds from it, and any difference is refused.

const ID = "2026-11-16";
const RECORD = { selection: "fixture", takenAt: "2026-11-16T04:05:00.000Z" };

describe("snapshot publish and rebuild", () => {
  let root: string;
  let objectsDir: string;
  let workDir: string;
  const model = fakeModel();
  const resolveModel = async () => model;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "snapshot-publish-"));
    objectsDir = join(root, "objects");
    workDir = join(root, "work");
    writeJobsParts(
      objectsDir,
      "ats",
      [
        snapshotJob(1),
        snapshotJob(2, { source: "lever", title: "d", descriptionText: "" }),
        snapshotJob(3),
      ],
      2,
    );
    writeObject(
      objectsDir,
      tablePartPath("companies", 0),
      encodeJsonl([{ id: 1, slug: "acme", source: "greenhouse", name: null }]),
    );
    await embedSlice({ objectsDir, workDir, slice: "ats", model, maxUsd: 1 });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const build = () =>
    buildManifest({ id: ID, objectsDir, workDir, sliceRecords: { ats: RECORD }, resolveModel });

  it("describes the snapshot from its objects: counts, flags, models, spend, checksums", async () => {
    const manifest = await build();

    expect(manifest.bucketPrefix).toBe("jobs/2026-11-16/");
    expect(manifest.slices.ats).toEqual({
      ...RECORD,
      jobs: 3,
      uniqueTexts: 3,
      bySource: { greenhouse: 2, lever: 1 },
      byFlag: { blank_description: 1, short_description: 0, short_title: 1, capped: 0 },
    });
    expect(manifest.tables).toEqual({ companies: 1, "location-strings": 0, places: 0 });
    expect(manifest.models).toEqual([
      expect.objectContaining({
        id: "fake/embed-1",
        slug: "fake-embed",
        host: "fake.test",
        dimensions: 4,
        tokens: expect.any(Number),
      }),
    ]);
    expect(manifest.models[0]?.tokens).toBeGreaterThan(0);
    expect(manifest.objects.map((o) => [o.path, o.rows])).toEqual([
      ["jobs/ats-0000.jsonl.gz", 2],
      ["jobs/ats-0001.jsonl.gz", 1],
      ["companies/part-0000.jsonl.gz", 1],
      ["vectors/fake-embed/ats-0000.f32", 2],
      ["vectors/fake-embed/ats-0001.f32", 1],
    ]);
    // The committed form is stable and parses back to the same manifest.
    expect(parseManifest(JSON.parse(serializeManifest(manifest)))).toEqual({
      ...manifest,
      objects: [...manifest.objects].sort((a, b) => (a.path < b.path ? -1 : 1)),
    });
  });

  it("rebuilds in a clean folder from the manifest and the bucket, and the checksums match", async () => {
    const manifest = await build();
    const store = memoryStore();
    const uploaded = await uploadSnapshot(manifest, null, objectsDir, store);
    expect(uploaded).toHaveLength(5);
    expect([...store.objects.keys()].every((k) => k.startsWith("jobs/2026-11-16/"))).toBe(true);

    const clean = join(root, "clean");
    expect(await downloadSnapshot(manifest, clean, store)).toEqual({ kept: 0, downloaded: 5 });
    expect(verifySnapshot(manifest, clean)).toEqual({
      jobs: 3,
      objects: 5,
      vectors: { "fake-embed": 3 },
    });
    for (const { path } of manifest.objects) {
      expect(
        Buffer.from(readObject(clean, path)).equals(Buffer.from(readObject(objectsDir, path))),
      ).toBe(true);
    }
    // A second rebuild keeps what is already there.
    expect(await downloadSnapshot(manifest, clean, store)).toEqual({ kept: 5, downloaded: 0 });
  });

  it("fails loudly when a downloaded object differs from the manifest", async () => {
    const manifest = await build();
    const store = memoryStore();
    await uploadSnapshot(manifest, null, objectsDir, store);
    const key = "jobs/2026-11-16/vectors/fake-embed/ats-0000.f32";
    const tampered = new Uint8Array(store.objects.get(key) as Uint8Array);
    tampered[0] = (tampered[0] as number) ^ 0xff;
    store.objects.set(key, tampered);

    await expect(downloadSnapshot(manifest, join(root, "clean"), store)).rejects.toThrow(
      /CHECKSUM MISMATCH for jobs\/2026-11-16\/vectors\/fake-embed\/ats-0000\.f32/,
    );
  });

  it("fails when the bucket lacks an object the manifest lists", async () => {
    const manifest = await build();
    await expect(downloadSnapshot(manifest, join(root, "clean"), memoryStore())).rejects.toThrow(
      /jobs\/2026-11-16\/jobs\/ats-0000\.jsonl\.gz is not in the bucket/,
    );
  });

  it("verification refuses a local object edited after the manifest was written", async () => {
    const manifest = await build();
    writeJobsParts(objectsDir, "ats", [snapshotJob(1), snapshotJob(7)], 2);
    expect(() => verifySnapshot(manifest, objectsDir)).toThrow(
      /CHECKSUM MISMATCH for jobs\/ats-0000/,
    );
  });

  it("refuses to publish a model that has not embedded every jobs part", async () => {
    writeJobsParts(objectsDir, "public", [snapshotJob(1_000_000_001, { slice: "public" })]);
    await expect(
      buildManifest({
        id: ID,
        objectsDir,
        workDir,
        sliceRecords: { ats: RECORD, public: RECORD },
        resolveModel,
      }),
    ).rejects.toThrow(
      /fake-embed has no finished embed run for the public slice as it is now \(no record\)/,
    );
  });

  it("refuses vectors made from other jobs, even when the file sizes still fit", async () => {
    // The slice is exported again with one job's text changed: same parts, same row counts.
    writeJobsParts(
      objectsDir,
      "ats",
      [
        snapshotJob(1),
        snapshotJob(2, { source: "lever", title: "d", descriptionText: "" }),
        snapshotJob(3, { title: "A different role" }),
      ],
      2,
    );
    await expect(build()).rejects.toThrow(/its record names other jobs or another setup/);
  });

  it("refuses vectors made by the model on another host or with another presentation", async () => {
    const moved = { ...model, host: "elsewhere.test" };
    await expect(
      buildManifest({
        id: ID,
        objectsDir,
        workDir,
        sliceRecords: { ats: RECORD },
        resolveModel: async () => moved,
      }),
    ).rejects.toThrow(/fake-embed has no finished embed run for the ats slice as it is now/);
  });

  it("verification refuses job ids that go backwards from one part to the next", async () => {
    const manifest = await build();
    // Part 0 holds ids 1-2 and part 1 holds id 3; swap them under the same checksums.
    const swapped = {
      ...manifest,
      objects: manifest.objects.map((o) => {
        const other =
          o.path === "jobs/ats-0000.jsonl.gz"
            ? "jobs/ats-0001.jsonl.gz"
            : o.path === "jobs/ats-0001.jsonl.gz"
              ? "jobs/ats-0000.jsonl.gz"
              : null;
        const source = other ? manifest.objects.find((x) => x.path === other) : null;
        return source ? { ...source, path: o.path } : o;
      }),
    };
    const first = readObject(objectsDir, "jobs/ats-0000.jsonl.gz");
    const second = readObject(objectsDir, "jobs/ats-0001.jsonl.gz");
    writeObject(objectsDir, "jobs/ats-0000.jsonl.gz", second);
    writeObject(objectsDir, "jobs/ats-0001.jsonl.gz", first);
    expect(() => verifySnapshot(swapped, objectsDir)).toThrow(
      /jobs\/ats-0001\.jsonl\.gz: job id 1 is out of order or repeated/,
    );
  });

  it("refuses a slice with no record of how it was chosen", async () => {
    await expect(
      buildManifest({ id: ID, objectsDir, workDir, sliceRecords: {}, resolveModel }),
    ).rejects.toThrow(/no record of how the ats slice was chosen/);
  });

  it("publishing again uploads only what is new and never replaces a published object", async () => {
    const first = await build();
    const store = memoryStore();
    await uploadSnapshot(first, null, objectsDir, store);

    // A second slice arrives later, with its own vectors.
    writeJobsParts(objectsDir, "public", [
      snapshotJob(1_000_000_001, { slice: "public", source: "usajobs" }),
    ]);
    await embedSlice({ objectsDir, workDir, slice: "public", model, maxUsd: 1 });
    const second = await buildManifest({
      id: ID,
      objectsDir,
      workDir,
      sliceRecords: { ats: RECORD, public: RECORD },
      resolveModel,
    });
    expect(await uploadSnapshot(second, first, objectsDir, store)).toEqual([
      "jobs/public-0000.jsonl.gz",
      "vectors/fake-embed/public-0000.f32",
    ]);
    expect(second.slices.public?.jobs).toBe(1);

    // A published object that changed locally is refused.
    const changed: Manifest = {
      ...second,
      objects: second.objects.map((o) =>
        o.path === "jobs/ats-0000.jsonl.gz" ? { ...o, sha256: "0".repeat(64) } : o,
      ),
    };
    await expect(uploadSnapshot(changed, first, objectsDir, store)).rejects.toThrow(
      /jobs\/ats-0000\.jsonl\.gz is already published with different content/,
    );
  });
});

describe("parseManifest", () => {
  const base = (): Manifest => ({
    format: 1,
    id: ID,
    bucketPrefix: "jobs/2026-11-16/",
    textCapChars: 60_000,
    slices: {
      ats: {
        ...RECORD,
        jobs: 2,
        uniqueTexts: 2,
        bySource: { greenhouse: 2 },
        byFlag: { blank_description: 0, short_description: 0, short_title: 0, capped: 0 },
      },
    },
    tables: { companies: 0, "location-strings": 0, places: 0 },
    models: [
      {
        id: "fake/embed-1",
        slug: "fake-embed",
        role: "challenger",
        host: "fake.test",
        dimensions: 4,
        presentation: { document: "as it is", query: "as it is" },
        pricePerMTokUsd: 1,
        tokens: 10,
        usd: 0.00001,
      },
    ],
    objects: [
      { path: "jobs/ats-0000.jsonl.gz", bytes: 100, sha256: "a".repeat(64), rows: 2 },
      { path: "vectors/fake-embed/ats-0000.f32", bytes: 32, sha256: "b".repeat(64), rows: 2 },
    ],
  });

  it("accepts a consistent manifest", () => {
    expect(parseManifest(base())).toEqual(base());
  });

  it("refuses counts that disagree with the listed objects", () => {
    const fewer = base();
    (fewer.slices.ats as { jobs: number }).jobs = 3;
    expect(() => parseManifest(fewer)).toThrow(/states 3 ats jobs but its objects hold 2/);
  });

  it("refuses a model without a vector for every job", () => {
    const short = base();
    short.objects[1] = { ...short.objects[1]!, rows: 1, bytes: 16 };
    expect(() => parseManifest(short)).toThrow(
      /states 2 ats fake-embed vectors but its objects hold 1/,
    );
  });

  it("refuses a vectors object whose size doesn't fit its rows and width", () => {
    const odd = base();
    odd.objects[1] = { ...odd.objects[1]!, bytes: 33 };
    expect(() => parseManifest(odd)).toThrow(/33 bytes is not 2 vectors of 4 dims/);
  });

  it("refuses a path listed twice and an unknown field", () => {
    const twice = base();
    twice.objects.push(twice.objects[0]!);
    expect(() => parseManifest(twice)).toThrow(/lists jobs\/ats-0000\.jsonl\.gz twice/);
    expect(() => parseManifest({ ...base(), extra: true })).toThrow(/invalid snapshot manifest/);
  });
});
