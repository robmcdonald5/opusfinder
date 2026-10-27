import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  EmbedCountMismatchError,
  embedNextPage,
  jobEmbeddingText,
  jobsNeedingEmbedding,
  nearestJobs,
  upsertCompany,
  upsertJobs,
  writeJobEmbeddings,
} from "@opusfinder/db/repos";
import { companies, jobs } from "@opusfinder/db/schema";
import { companySlug, jobId, type NormalizedJob } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";
import { oneHot } from "@test/db/vectors";

function job(
  externalId: string,
  title: string,
  descriptionText = `${title} description body`,
): NormalizedJob {
  return {
    source: "greenhouse",
    externalId: jobId(externalId),
    title,
    companySlug: companySlug("acme"),
    locations: ["Remote - US"],
    remote: true,
    descriptionText,
    applyUrl: `https://example.test/${externalId}`,
    postedAt: null,
  };
}

/** A fake embedder: one one-hot vector per text. */
async function fakeEmbed(texts: string[]) {
  return { embeddings: texts.map((_, i) => oneHot(i)), usage: { totalTokens: texts.length } };
}

// Phase 0 pilot — the load-bearing PGlite integration spec. It proves R1 (the neon-http `Db` cast works
// over the PGlite driver for BOTH the typed query builder and raw `db.execute` → resultRows) and R2 (the
// real migration set, pgvector DDL included, applies under PGlite's pgvector) by round-tripping through
// the actual repo functions and asserting `<=>` ordering.
describe("pgvector retrieval over PGlite (pilot: R1 driver compat + R2 pgvector migration DDL)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => {
    // Optional-chained: if beforeAll's createTestDb() rejected, a bare close() would bury the real
    // failure under a secondary TypeError. Drains the WASM handle → clean Windows teardown.
    await close?.();
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

    // jobsNeedingEmbedding: typed SELECT + the content regex. Both rows start NULL and have
    // non-whitespace content, so both come back.
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

describe("embed backlog — selection, guarded write, page (integration: real PGlite)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;
  let companyId: number;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    await truncate(db, companies, jobs);
    companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
  });
  afterAll(async () => {
    await close?.();
  });

  async function idOf(externalId: string): Promise<number> {
    const [row] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.externalId, jobId(externalId)));
    return row!.id;
  }

  it("selects only active jobs, newest first, and picks a revived job up again", async () => {
    await upsertJobs(db, companyId, [job("a", "Role A"), job("b", "Role B"), job("c", "Role C")]);
    const [a, b, c] = [await idOf("a"), await idOf("b"), await idOf("c")];

    // Retrieval never reads a closed job, so paying to embed one is waste.
    await db.update(jobs).set({ lifecycleState: "closed" }).where(eq(jobs.id, b));
    expect((await jobsNeedingEmbedding(db, { limit: 10 })).map((j) => j.id)).toEqual([c, a]);

    await db.update(jobs).set({ lifecycleState: "active" }).where(eq(jobs.id, b));
    expect((await jobsNeedingEmbedding(db, { limit: 10 })).map((j) => j.id)).toEqual([c, b, a]);
  });

  it("never selects a job whose text JS trim() empties — every such code point, ASCII or not", async () => {
    // Such a row composes to "", Voyage 400s the whole page, and the cursorless drain re-selects that page
    // forever. Derived from the engine so a code point missing from the SQL class can't hide.
    const blanks: string[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      if (String.fromCharCode(c).trim() === "") blanks.push(String.fromCharCode(c));
    }
    await upsertJobs(db, companyId, [
      ...blanks.map((ch, i) => job(`blank-${i}`, ch.repeat(2), ch)),
      job("real", "Real Role"),
    ]);
    for (const ch of blanks)
      expect(jobEmbeddingText({ title: ch.repeat(2), descriptionText: ch })).toBe("");

    expect((await jobsNeedingEmbedding(db, { limit: 100 })).map((j) => j.title)).toEqual([
      "Real Role",
    ]);
  });

  it("skips a job whose text changed while its page was embedding, then embeds the new text", async () => {
    await upsertJobs(db, companyId, [job("x", "Role X", "first body")]);
    const x = await idOf("x");

    // An ingest tick rewrites the description while the Voyage call is in flight.
    const page = await embedNextPage(
      db,
      async (texts) => {
        await upsertJobs(db, companyId, [job("x", "Role X", "second body")]);
        return fakeEmbed(texts);
      },
      { limit: 10 },
    );

    expect(page).toEqual({ embedded: 0, tokens: 1, done: true });
    const [pending] = await jobsNeedingEmbedding(db, { limit: 10 });
    expect(pending).toMatchObject({ id: x, descriptionText: "second body" });

    expect(await embedNextPage(db, fakeEmbed, { limit: 10 })).toEqual({
      embedded: 1,
      tokens: 1,
      done: true,
    });
    expect(await jobsNeedingEmbedding(db, { limit: 10 })).toEqual([]);
  });

  it("throws EmbedCountMismatchError and writes nothing when the embedder returns the wrong vector count", async () => {
    await upsertJobs(db, companyId, [job("p", "Role P"), job("q", "Role Q")]);
    const short = async (texts: string[]) => fakeEmbed(texts.slice(1));

    await expect(embedNextPage(db, short, { limit: 10 })).rejects.toBeInstanceOf(
      EmbedCountMismatchError,
    );
    const rows = await db
      .select({ embedding: jobs.embedding })
      .from(jobs)
      .where(inArray(jobs.id, [await idOf("p"), await idOf("q")]));
    expect(rows.every((r) => r.embedding === null)).toBe(true);
  });
});
