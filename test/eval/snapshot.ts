import type { SnapshotModel } from "../../packages/eval/src/embedders/snapshot-models";
import {
  encodeJsonl,
  jobFlags,
  jobsPartPath,
  sha256Hex,
  type SnapshotJob,
  type SnapshotSlice,
} from "../../packages/eval/src/snapshot/format";
import { writeObject } from "../../packages/eval/src/snapshot/store";
import type { PutObjectInput, StorageClient } from "@opusfinder/storage";

/** A snapshot job with sensible defaults; `flags` are computed, as the export computes them. */
export function snapshotJob(
  id: number,
  fields: Partial<SnapshotJob> & { title?: string; descriptionText?: string } = {},
): SnapshotJob {
  const text = {
    title: fields.title ?? `Role ${id}`,
    descriptionText: fields.descriptionText ?? `A full description of role ${id}. `.repeat(12),
  };
  return {
    id,
    slice: "ats",
    source: "greenhouse",
    externalId: `ext-${id}`,
    companyId: 1,
    locations: [],
    remote: false,
    applyUrl: `https://example.test/${id}`,
    postedAt: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    lastSeenAt: "2026-11-15T00:00:00.000Z",
    contentSignature: null,
    productionEmbeddingModel: null,
    ...fields,
    ...text,
    flags: jobFlags(text),
  };
}

/** Write jobs as one slice's parts, `perPart` jobs each. */
export function writeJobsParts(
  objectsDir: string,
  slice: SnapshotSlice,
  jobs: SnapshotJob[],
  perPart = jobs.length,
): void {
  for (let part = 0; part * perPart < jobs.length; part++) {
    const page = jobs.slice(part * perPart, (part + 1) * perPart);
    writeObject(objectsDir, jobsPartPath(slice, part), encodeJsonl(page));
  }
}

export interface FakeModel extends SnapshotModel {
  /** Every batch sent, in order. */
  requests: string[][];
}

/**
 * A snapshot model that answers offline: a 4-dim vector derived from each text's hash (equal texts
 * give equal vectors), and one token per character. `failures` makes the next N requests throw a
 * retryable error first.
 */
export function fakeModel(
  overrides: Partial<SnapshotModel> & { failures?: number } = {},
): FakeModel {
  const { failures: failFirst = 0, ...rest } = overrides;
  let failures = failFirst;
  const model: FakeModel = {
    id: "fake/embed-1",
    slug: "fake-embed",
    role: "challenger",
    host: "fake.test",
    dimensions: 4,
    pricePerMTokUsd: 1,
    limits: { maxItems: 2, maxTokens: 1_000_000, charsPerToken: 1 },
    presentation: { document: "as it is", query: "as it is" },
    requests: [],
    async embedBatch(texts) {
      if (failures > 0) {
        failures--;
        throw new Error("503 Service Unavailable");
      }
      model.requests.push(texts);
      return {
        embeddings: texts.map(fakeVector),
        totalTokens: texts.reduce((sum, t) => sum + t.length, 0),
      };
    },
    ...rest,
  };
  return model;
}

/** The fake model's vector for a text. */
export function fakeVector(text: string): number[] {
  const hash = sha256Hex(text);
  return [0, 1, 2, 3].map((i) => parseInt(hash.slice(i * 4, i * 4 + 4), 16) / 65535);
}

/** An in-memory object store. */
export function memoryStore(): StorageClient & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async putObject({ key, body }: PutObjectInput) {
      objects.set(
        key,
        typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body),
      );
    },
    async getObject(key) {
      return objects.get(key) ?? null;
    },
    async deleteObject(key) {
      objects.delete(key);
    },
    close() {},
  };
}
