import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  backfillJobEmbeddings,
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
import { rejectionOf } from "@test/rejection";
import { truncate } from "@test/db/truncate";
import { oneHot, tagged, TEST_MODEL } from "@test/db/vectors";

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
  return {
    embeddings: texts.map((_, i) => oneHot(i)),
    usage: { totalTokens: texts.length },
    model: TEST_MODEL,
  };
}

/** A fake embedder that records each provider request (a call with texts; the empty call that only
 *  asks for the model is not one) and gives every text it is sent a vector of its own. */
function recordingEmbed() {
  const requests: string[][] = [];
  let next = 0;
  const embed = async (texts: string[]) => {
    if (texts.length > 0) requests.push(texts);
    return {
      embeddings: texts.map(() => oneHot(next++)),
      usage: { totalTokens: texts.length },
      model: TEST_MODEL,
    };
  };
  return { embed, requests };
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
    const written = await writeJobEmbeddings(
      db,
      [
        { id: pending[0]!.id, embedding: oneHot(0) },
        { id: pending[1]!.id, embedding: oneHot(1) },
      ],
      TEST_MODEL,
    );
    expect(written).toBe(2);

    // nearestJobs: raw `embedding <=> $1` cosine query. Querying with job-0's exact vector ranks job-0
    // first at distance 0; job-1 (orthogonal) is strictly farther.
    const neighbours = await nearestJobs(db, tagged(oneHot(0)), 5);
    expect(neighbours).toHaveLength(2);
    expect(neighbours[0]!.id).toBe(pending[0]!.id);
    expect(neighbours[0]!.distance).toBeCloseTo(0, 5);
    expect(neighbours[1]!.distance).toBeGreaterThan(neighbours[0]!.distance);

    // The same vector under another model's tag is in another space: it has no neighbours here.
    expect(await nearestJobs(db, tagged(oneHot(0), "other-model"), 5)).toEqual([]);
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
        if (texts.length > 0) await upsertJobs(db, companyId, [job("x", "Role X", "second body")]);
        return fakeEmbed(texts);
      },
      { limit: 10 },
    );

    expect(page).toEqual({ embedded: 0, reused: 0, tokens: 1, done: true });
    const [pending] = await jobsNeedingEmbedding(db, { limit: 10 });
    expect(pending).toMatchObject({ id: x, descriptionText: "second body" });

    expect(await embedNextPage(db, fakeEmbed, { limit: 10 })).toEqual({
      embedded: 1,
      reused: 0,
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

  it("stores the embedder's model beside every vector it writes, and replaces the tag on a rewrite", async () => {
    await upsertJobs(db, companyId, [job("1", "Role One"), job("2", "Role Two")]);
    const stored = () =>
      db
        .select({ embedding: jobs.embedding, embeddingModel: jobs.embeddingModel })
        .from(jobs)
        .orderBy(jobs.id);

    // The page writer takes the tag from the embedder's result, not from any constant.
    const embed = async (texts: string[]) => ({ ...(await fakeEmbed(texts)), model: "model-a" });
    expect(await embedNextPage(db, embed, { limit: 10 })).toMatchObject({ embedded: 2 });
    for (const row of await stored()) {
      expect(row.embedding).not.toBeNull();
      expect(row.embeddingModel).toBe("model-a");
    }

    // Re-embedding a row under another model moves its tag with the vector.
    const [first] = await db.select({ id: jobs.id }).from(jobs).orderBy(jobs.id).limit(1);
    await writeJobEmbeddings(db, [{ id: first!.id, embedding: oneHot(5) }], "model-b");
    expect((await stored()).map((r) => r.embeddingModel)).toEqual(["model-b", "model-a"]);
  });

  it("the database refuses a vector without a tag, and a tag without a vector", async () => {
    await upsertJobs(db, companyId, [job("1", "Role One")]);

    const untagged = await rejectionOf(db.update(jobs).set({ embedding: oneHot(0) }));
    // Drizzle wraps the driver error; the constraint name is on the cause.
    expect(String(untagged.cause ?? untagged)).toMatch(/jobs_embedding_model_paired/);
    const vectorless = await rejectionOf(db.update(jobs).set({ embeddingModel: TEST_MODEL }));
    expect(String(vectorless.cause ?? vectorless)).toMatch(/jobs_embedding_model_paired/);
  });
});

describe("embed backlog — identical text is embedded once (integration: real PGlite)", () => {
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

  /** The stored vector, tag and text of each job, keyed by external id. */
  async function stored() {
    const rows = await db
      .select({
        externalId: jobs.externalId,
        embedding: jobs.embedding,
        embeddingModel: jobs.embeddingModel,
        descriptionText: jobs.descriptionText,
        contentSignature: jobs.contentSignature,
      })
      .from(jobs);
    return new Map(rows.map((row) => [String(row.externalId), row]));
  }

  /** Seed one job that already holds `embedding` under `model`. */
  async function seedEmbedded(
    externalId: string,
    title: string,
    body: string,
    embedding: number[],
    model = TEST_MODEL,
  ): Promise<number> {
    await upsertJobs(db, companyId, [job(externalId, title, body)]);
    const [row] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.externalId, jobId(externalId)));
    await writeJobEmbeddings(db, [{ id: row!.id, embedding }], model);
    return row!.id;
  }

  it("embeds one text shared by a page's jobs once and writes the vector to all of them", async () => {
    // One posting listed in five places, and one unrelated posting.
    await upsertJobs(db, companyId, [
      ...[1, 2, 3, 4, 5].map((n) => job(`shared-${n}`, "Store Associate", "Stock the shelves.")),
      job("other", "Store Manager", "Run the store."),
    ]);
    const { embed, requests } = recordingEmbed();

    expect(await embedNextPage(db, embed, { limit: 10 })).toEqual({
      embedded: 2,
      reused: 4,
      tokens: 2,
      done: true,
    });

    // One provider request, each distinct text in it once.
    expect(requests).toHaveLength(1);
    expect([...requests[0]!].sort()).toEqual([
      jobEmbeddingText({ title: "Store Associate", descriptionText: "Stock the shelves." }),
      jobEmbeddingText({ title: "Store Manager", descriptionText: "Run the store." }),
    ]);
    const rows = await stored();
    const shared = [1, 2, 3, 4, 5].map((n) => rows.get(`shared-${n}`)!);
    expect(shared[0]!.embedding).not.toBeNull();
    for (const row of shared) {
      expect(row.embedding).toEqual(shared[0]!.embedding);
      expect(row.embeddingModel).toBe(TEST_MODEL);
    }
    expect(rows.get("other")!.embedding).not.toEqual(shared[0]!.embedding);
  });

  it("copies a stored vector to later pages' jobs with the same text, with no provider call", async () => {
    await upsertJobs(
      db,
      companyId,
      [1, 2, 3, 4, 5].map((n) => job(`shared-${n}`, "Store Associate", "Stock the shelves.")),
    );
    const { embed, requests } = recordingEmbed();

    // Pages of two: the first embeds the text, every later page copies the stored vector.
    expect(await backfillJobEmbeddings(db, embed, { batchSize: 2 })).toEqual({
      embedded: 1,
      reused: 4,
      tokens: 1,
    });

    expect(requests).toEqual([
      [jobEmbeddingText({ title: "Store Associate", descriptionText: "Stock the shelves." })],
    ]);
    const rows = [...(await stored()).values()];
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.embedding).toEqual(rows[0]!.embedding);
      expect(row.embeddingModel).toBe(TEST_MODEL);
    }
    expect(await jobsNeedingEmbedding(db, { limit: 10 })).toEqual([]);
  });

  it("copies from a closed job too: its vector is the same text's vector", async () => {
    const source = await seedEmbedded("old", "Store Associate", "Stock the shelves.", oneHot(7));
    await db.update(jobs).set({ lifecycleState: "closed" }).where(eq(jobs.id, source));
    await upsertJobs(db, companyId, [job("repost", "Store Associate", "Stock the shelves.")]);
    const { embed, requests } = recordingEmbed();

    expect(await embedNextPage(db, embed, { limit: 10 })).toEqual({
      embedded: 0,
      reused: 1,
      tokens: 0,
      done: true,
    });
    expect(requests).toEqual([]);
    expect((await stored()).get("repost")).toMatchObject({
      embedding: oneHot(7),
      embeddingModel: TEST_MODEL,
    });
  });

  it("never reuses a vector of another model: the job is embedded on the embedder's model", async () => {
    await seedEmbedded("old", "Store Associate", "Stock the shelves.", oneHot(7), "retired-model");
    await upsertJobs(db, companyId, [job("new", "Store Associate", "Stock the shelves.")]);
    const { embed, requests } = recordingEmbed();

    expect(await embedNextPage(db, embed, { limit: 10 })).toMatchObject({ embedded: 1, reused: 0 });

    expect(requests).toHaveLength(1);
    const rows = await stored();
    expect(rows.get("new")).toMatchObject({ embedding: oneHot(0), embeddingModel: TEST_MODEL });
    expect(rows.get("old")).toMatchObject({
      embedding: oneHot(7),
      embeddingModel: "retired-model",
    });
  });

  it("embeds a job whose text differs only in case or spacing: one signature, another text", async () => {
    await seedEmbedded("plain", "Store Associate", "Stock the shelves.", oneHot(7));
    await upsertJobs(db, companyId, [job("shouted", "STORE ASSOCIATE", "Stock  the shelves.")]);
    const { embed, requests } = recordingEmbed();

    expect(await embedNextPage(db, embed, { limit: 10 })).toMatchObject({ embedded: 1, reused: 0 });

    expect(requests).toEqual([
      [jobEmbeddingText({ title: "STORE ASSOCIATE", descriptionText: "Stock  the shelves." })],
    ]);
    const rows = await stored();
    expect(rows.get("shouted")!.contentSignature).toBe(rows.get("plain")!.contentSignature);
    expect(rows.get("shouted")!.embedding).toEqual(oneHot(0));
  });

  it("doesn't copy a stored vector to a job whose text changed after the page was read", async () => {
    await seedEmbedded("source", "Store Associate", "Stock the shelves.", oneHot(7));
    await upsertJobs(db, companyId, [job("x", "Store Associate", "Stock the shelves.")]);
    const { embed, requests } = recordingEmbed();

    // An ingest tick rewrites the description between the page read and the copy (the model-only call
    // sits between the two).
    const page = await embedNextPage(
      db,
      async (texts) => {
        if (texts.length === 0) {
          await upsertJobs(db, companyId, [job("x", "Store Associate", "Count the tills.")]);
        }
        return embed(texts);
      },
      { limit: 10 },
    );

    // Not copied; the text as read went to the provider and the write guard dropped its vector.
    expect(page).toEqual({ embedded: 0, reused: 0, tokens: 1, done: true });
    expect((await stored()).get("x")).toMatchObject({
      embedding: null,
      descriptionText: "Count the tills.",
    });

    expect(await embedNextPage(db, embed, { limit: 10 })).toMatchObject({ embedded: 1, reused: 0 });
    expect(requests.at(-1)).toEqual([
      jobEmbeddingText({ title: "Store Associate", descriptionText: "Count the tills." }),
    ]);
  });

  it("doesn't give a shared vector to a job whose text changed while the page was embedding", async () => {
    await upsertJobs(db, companyId, [
      job("kept", "Store Associate", "Stock the shelves."),
      job("edited", "Store Associate", "Stock the shelves."),
    ]);
    const { embed } = recordingEmbed();

    const page = await embedNextPage(
      db,
      async (texts) => {
        if (texts.length > 0) {
          await upsertJobs(db, companyId, [job("edited", "Store Associate", "Count the tills.")]);
        }
        return embed(texts);
      },
      { limit: 10 },
    );

    expect(page).toEqual({ embedded: 1, reused: 0, tokens: 1, done: true });
    const rows = await stored();
    expect(rows.get("kept")!.embedding).toEqual(oneHot(0));
    expect(rows.get("edited")).toMatchObject({
      embedding: null,
      descriptionText: "Count the tills.",
    });
  });
});
