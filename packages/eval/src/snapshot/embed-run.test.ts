import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EmbeddingRejectedError } from "@opusfinder/embeddings";

import { fakeModel, fakeVector, snapshotJob, writeJobsParts } from "@test/eval/snapshot";

import { embedSlice, modelSpend, planSlice, readSpend } from "./embed-run";
import { decodeVectors, snapshotEmbedText } from "./format";
import { readObject } from "./store";

// The embedding run over a local snapshot folder with an offline model: one vector per distinct text,
// resume from finished chunks, and the spend cap.

describe("embedSlice", () => {
  let root: string;
  let objectsDir: string;
  let workDir: string;
  const noSleep = () => Promise.resolve();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "snapshot-embed-"));
    objectsDir = join(root, "objects");
    workDir = join(root, "work");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const vectorsOf = (path: string, dimensions = 4) =>
    Array.from(decodeVectors(readObject(objectsDir, path), dimensions, path));
  const float32 = (v: number[]) => Array.from(new Float32Array(v));

  it("embeds each distinct text once and writes a vectors part aligned to each jobs part", async () => {
    const twin = { title: "Nurse", descriptionText: "Same posting on two boards. ".repeat(10) };
    const jobs = [snapshotJob(1), snapshotJob(2, twin), snapshotJob(3), snapshotJob(4, twin)];
    writeJobsParts(objectsDir, "ats", jobs, 2);
    const model = fakeModel();

    const result = await embedSlice({ objectsDir, workDir, slice: "ats", model, maxUsd: 1 });

    expect(result).toMatchObject({
      status: "complete",
      jobs: 4,
      uniqueTexts: 3,
      chunksEmbedded: 1,
    });
    // Three texts went out, the cross-post only once.
    expect(model.requests.flat()).toHaveLength(3);
    const text = (i: number) => snapshotEmbedText(jobs[i]!).text;
    expect(vectorsOf("vectors/fake-embed/ats-0000.f32")).toEqual(
      float32([...fakeVector(text(0)), ...fakeVector(text(1))]),
    );
    // Job 4 carries job 2's text, so it carries job 2's vector.
    expect(vectorsOf("vectors/fake-embed/ats-0001.f32")).toEqual(
      float32([...fakeVector(text(2)), ...fakeVector(text(1))]),
    );
    // Spend is what the provider reported, at the list price.
    const tokens = [0, 1, 2].reduce((sum, i) => sum + text(i).length, 0);
    expect(modelSpend(workDir, "fake-embed")).toEqual({ tokens, usd: tokens / 1_000_000 });
    expect(result.tokens).toBe(tokens);
  });

  it("gives a job with no text an all-zero vector and embeds nothing for it", async () => {
    writeJobsParts(objectsDir, "ats", [
      snapshotJob(1, { title: " ", descriptionText: "" }),
      snapshotJob(2),
    ]);
    const model = fakeModel();

    await embedSlice({ objectsDir, workDir, slice: "ats", model, maxUsd: 1 });

    expect(model.requests.flat()).toHaveLength(1);
    expect(vectorsOf("vectors/fake-embed/ats-0000.f32").slice(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it("re-running a finished slice sends nothing and spends nothing", async () => {
    writeJobsParts(objectsDir, "ats", [snapshotJob(1), snapshotJob(2), snapshotJob(3)]);
    await embedSlice({ objectsDir, workDir, slice: "ats", model: fakeModel(), maxUsd: 1 });
    const spent = readSpend(workDir).length;

    const again = fakeModel();
    const result = await embedSlice({ objectsDir, workDir, slice: "ats", model: again, maxUsd: 1 });

    expect(again.requests).toEqual([]);
    expect(result).toMatchObject({
      status: "complete",
      chunksReused: 1,
      chunksEmbedded: 0,
      tokens: 0,
    });
    expect(readSpend(workDir)).toHaveLength(spent);
  });

  it("stops before the request that would pass the cap, then resumes under a higher one", async () => {
    // 600 distinct texts = two chunks (512 + 88). One token per character at $1/1M tokens.
    const jobs = Array.from({ length: 600 }, (_x, i) => snapshotJob(i + 1));
    writeJobsParts(objectsDir, "ats", jobs, 300);
    const chars = (from: number, to: number) =>
      jobs.slice(from, to).reduce((sum, j) => sum + snapshotEmbedText(j).text.length, 0);
    const firstChunkUsd = chars(0, 512) / 1_000_000;
    const capped = fakeModel({ limits: { maxItems: 64, maxTokens: 1_000_000, charsPerToken: 1 } });

    const stopped = await embedSlice({
      objectsDir,
      workDir,
      slice: "ats",
      model: capped,
      // Room for the first chunk and part of the second.
      maxUsd: firstChunkUsd + chars(512, 550) / 1_000_000,
      concurrency: 1,
    });

    expect(stopped.status).toBe("stopped_at_cap");
    expect(stopped.chunksEmbedded).toBe(1);
    // Never past the cap, and every billed request is on the record.
    const recorded = readSpend(workDir).reduce((sum, l) => sum + l.usd, 0);
    expect(recorded).toBeLessThanOrEqual(firstChunkUsd + chars(512, 550) / 1_000_000);
    expect(recorded).toBeCloseTo(stopped.usd, 12);
    // No vectors part is written for a slice that isn't whole.
    expect(() => readObject(objectsDir, "vectors/fake-embed/ats-0000.f32")).toThrow();

    const resumed = fakeModel({ limits: capped.limits });
    const done = await embedSlice({ objectsDir, workDir, slice: "ats", model: resumed, maxUsd: 1 });

    expect(done).toMatchObject({ status: "complete", chunksReused: 1, chunksEmbedded: 1 });
    // Only the second chunk's texts were sent again.
    expect(resumed.requests.flat()).toHaveLength(88);
    expect(vectorsOf("vectors/fake-embed/ats-0001.f32")).toHaveLength(300 * 4);
  });

  it("counts other models' recorded spend against the same cap", async () => {
    writeJobsParts(objectsDir, "ats", [snapshotJob(1), snapshotJob(2)]);
    const first = await embedSlice({
      objectsDir,
      workDir,
      slice: "ats",
      model: fakeModel(),
      maxUsd: 1,
    });

    const other = fakeModel({ slug: "other-embed" });
    const result = await embedSlice({
      objectsDir,
      workDir,
      slice: "ats",
      model: other,
      // The first model used the whole allowance.
      maxUsd: first.usd,
    });

    expect(result.status).toBe("stopped_at_cap");
    expect(other.requests).toEqual([]);
  });

  it("retries a request the provider didn't reject and records only the billed attempt", async () => {
    writeJobsParts(objectsDir, "ats", [snapshotJob(1)]);
    const model = fakeModel({ failures: 2 });

    const result = await embedSlice({
      objectsDir,
      workDir,
      slice: "ats",
      model,
      maxUsd: 1,
      sleep: noSleep,
    });

    expect(result.status).toBe("complete");
    expect(readSpend(workDir)).toHaveLength(1);
  });

  it("does not retry a rejected request", async () => {
    writeJobsParts(objectsDir, "ats", [snapshotJob(1)]);
    let calls = 0;
    const model = fakeModel({
      embedBatch: async () => {
        calls++;
        throw new EmbeddingRejectedError("400 Bad Request");
      },
    });

    await expect(
      embedSlice({ objectsDir, workDir, slice: "ats", model, maxUsd: 1, sleep: noSleep }),
    ).rejects.toThrow(/400 Bad Request/);
    expect(calls).toBe(1);
  });

  it("a chunk from a different set of jobs is not reused", async () => {
    writeJobsParts(objectsDir, "ats", [snapshotJob(1), snapshotJob(2)]);
    await embedSlice({ objectsDir, workDir, slice: "ats", model: fakeModel(), maxUsd: 1 });

    // The slice changes underneath the finished chunk.
    writeJobsParts(objectsDir, "ats", [snapshotJob(1), snapshotJob(9)]);
    const model = fakeModel();
    const result = await embedSlice({ objectsDir, workDir, slice: "ats", model, maxUsd: 1 });

    expect(result).toMatchObject({ chunksReused: 0, chunksEmbedded: 1 });
    expect(model.requests.flat()).toHaveLength(2);
  });
});

describe("planSlice", () => {
  it("fails when the slice has no jobs", () => {
    const empty = mkdtempSync(join(tmpdir(), "snapshot-plan-"));
    try {
      expect(() => planSlice(empty, "ats")).toThrow(/no ats jobs/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
