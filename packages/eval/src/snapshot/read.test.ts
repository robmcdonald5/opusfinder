import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fakeModel, fakeVector, snapshotJob, writeJobsParts } from "@test/eval/snapshot";

import { embedSlice } from "./embed-run";
import { encodeJsonl, snapshotEmbedText, tablePartPath, truncateVector } from "./format";
import { serializeManifest } from "./manifest";
import { buildManifest } from "./publish";
import { openSnapshot, type Snapshot } from "./read";
import { snapshotPaths, writeObject } from "./store";

// Reading a rebuilt snapshot the way a harness will: jobs in order, tables, and a model's vectors
// lined up with the jobs, at the stored width or cut to a narrower one.

const ID = "2026-11-16";
const RECORD = { selection: "fixture", takenAt: "2026-11-16T04:05:00.000Z" };

describe("openSnapshot", () => {
  let root: string;
  let snapshot: Snapshot;
  const ats = [snapshotJob(1), snapshotJob(2), snapshotJob(3)];
  const pub = [snapshotJob(1_000_000_001, { slice: "public", source: "usajobs" })];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "snapshot-read-"));
    const paths = snapshotPaths(ID, root);
    const model = fakeModel();
    // Written public-first: reading still goes ats, then public.
    writeJobsParts(paths.objects, "public", pub);
    writeJobsParts(paths.objects, "ats", ats, 2);
    const company = { id: 1, slug: "acme", source: "greenhouse", name: "Acme" };
    writeObject(paths.objects, tablePartPath("companies", 0), encodeJsonl([company]));
    for (const slice of ["ats", "public"] as const) {
      await embedSlice({ objectsDir: paths.objects, workDir: paths.work, slice, model, maxUsd: 1 });
    }
    const manifest = await buildManifest({
      id: ID,
      objectsDir: paths.objects,
      workDir: paths.work,
      sliceRecords: { ats: RECORD, public: RECORD },
      resolveModel: async () => model,
    });
    writeFileSync(paths.manifest, serializeManifest(manifest));
    snapshot = openSnapshot(ID, root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("yields jobs slice by slice, in id order, and one slice on request", () => {
    expect([...snapshot.jobs()].map((j) => j.id)).toEqual([1, 2, 3, 1_000_000_001]);
    expect([...snapshot.jobs("public")].map((j) => j.source)).toEqual(["usajobs"]);
  });

  it("reads a table's rows", () => {
    expect(snapshot.table("companies")).toEqual([
      { id: 1, slug: "acme", source: "greenhouse", name: "Acme" },
    ]);
    expect(snapshot.table("places")).toEqual([]);
  });

  it("gives a model's vectors lined up with the jobs, tagged with the model's id", () => {
    const vectors = snapshot.vectors("fake-embed");
    expect(vectors.model).toBe("fake/embed-1");
    expect(vectors.dimensions).toBe(4);
    expect(vectors.jobIds).toEqual([1, 2, 3, 1_000_000_001]);
    const expected = [...ats, ...pub].flatMap((job) => fakeVector(snapshotEmbedText(job).text));
    expect(Array.from(vectors.matrix)).toEqual(Array.from(new Float32Array(expected)));
  });

  it("cuts vectors to a narrower width and re-normalises each", () => {
    const cut = snapshot.vectors("fake-embed", { width: 2 });
    expect(cut.dimensions).toBe(2);
    expect(cut.matrix).toHaveLength(4 * 2);
    const third = truncateVector(new Float32Array(fakeVector(snapshotEmbedText(ats[2]!).text)), 2);
    expect(Array.from(cut.matrix.subarray(4, 6))).toEqual(Array.from(third));
    expect(Math.hypot(cut.matrix[4]!, cut.matrix[5]!)).toBeCloseTo(1, 5);
  });

  it("names the models it has when asked for one it lacks", () => {
    expect(() => snapshot.vectors("voyage-4-large")).toThrow(
      /no model "voyage-4-large" \(it has: fake-embed\)/,
    );
  });
});
