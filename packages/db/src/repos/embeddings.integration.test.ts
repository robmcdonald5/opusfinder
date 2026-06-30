import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  jobsNeedingEmbedding,
  nearestJobs,
  upsertCompany,
  upsertJobs,
  writeJobEmbeddings,
} from "@opusfinder/db/repos";
import { companySlug, jobId, type NormalizedJob } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";

// A 1024-dim (EMBEDDING_DIMENSIONS) one-hot vector. Orthogonal one-hots give exact cosine distances —
// distance(v_i, v_i) == 0 and distance(v_i, v_j) == 1 for i != j — so the ordering assertion is precise.
function oneHot(index: number): number[] {
  const v = new Array<number>(1024).fill(0);
  v[index] = 1;
  return v;
}

function job(externalId: string, title: string): NormalizedJob {
  return {
    source: "greenhouse",
    externalId: jobId(externalId),
    title,
    companySlug: companySlug("acme"),
    locations: ["Remote - US"],
    remote: true,
    descriptionText: `${title} description body`,
    applyUrl: `https://example.test/${externalId}`,
    postedAt: null,
    raw: {},
  };
}

// Phase 0 pilot — the load-bearing PGlite integration spec. It proves R1 (the neon-http `Db` cast works
// over the PGlite driver for BOTH the typed query builder and raw `db.execute` → resultRows) and R2 (the
// real migration set, including the two `USING hnsw (... vector_cosine_ops)` indexes, applies under
// PGlite's pgvector) by round-tripping through the actual repo functions and asserting `<=>` ordering.
describe("pgvector retrieval over PGlite (pilot: R1 driver compat + R2 HNSW migration DDL)", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => {
    await close(); // drain the WASM handle → clean Windows teardown (no UV_HANDLE_CLOSING)
  });

  it("round-trips company → jobs → embeddings and orders neighbours by cosine distance", async () => {
    // upsertCompany: typed INSERT ... ON CONFLICT ... RETURNING.
    const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
    expect(companyId).toBeGreaterThan(0);

    // upsertJobs: typed INSERT ... ON CONFLICT with the SQL-side signatureSql (md5/regexp_replace/btrim) —
    // proves Postgres core functions run under PGlite, not just trivial CRUD.
    const { changed, total } = await upsertJobs(db, companyId, [
      job("ext-a", "Senior Platform Engineer"),
      job("ext-b", "Staff Data Scientist"),
    ]);
    expect(total).toBe(2);
    expect(changed).toBe(2);

    // jobsNeedingEmbedding: typed SELECT + the `~ '[^[:space:]]'` POSIX predicate. Both rows start NULL
    // and have non-whitespace content, so both come back, ordered by id.
    const pending = await jobsNeedingEmbedding(db, { limit: 10 });
    expect(pending).toHaveLength(2);

    // writeJobEmbeddings: raw `db.execute` UPDATE ... FROM (VALUES ...) with the ::vector(1024) cast,
    // result normalized through resultRows() — the exact R1 raw-SQL path. Orthogonal one-hot vectors.
    const written = await writeJobEmbeddings(db, [
      { id: pending[0]!.id, embedding: oneHot(0) },
      { id: pending[1]!.id, embedding: oneHot(1) },
    ]);
    expect(written).toBe(2);

    // nearestJobs: raw `embedding <=> $1` cosine query. Querying with job-0's exact vector ranks job-0
    // first at distance 0; job-1 (orthogonal) is strictly farther.
    const neighbours = await nearestJobs(db, oneHot(0), 5);
    expect(neighbours).toHaveLength(2);
    expect(neighbours[0]!.id).toBe(pending[0]!.id);
    expect(neighbours[0]!.distance).toBeCloseTo(0, 5);
    expect(neighbours[1]!.distance).toBeGreaterThan(neighbours[0]!.distance);
  });
});
