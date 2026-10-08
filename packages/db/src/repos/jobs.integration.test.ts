import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import { listCompanies, upsertCompany, upsertJobs, writeJobEmbeddings } from "@opusfinder/db/repos";
import { companies, EMBEDDING_DIMENSIONS, jobs } from "@opusfinder/db/schema";
import { companySlug, jobId, type NormalizedJob } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";
import { truncate } from "@test/db/truncate";
import { oneHot } from "@test/db/vectors";

import { moveToListingBoard } from "./jobs";
import { NUL, normalizeSignatureText } from "./sql";

// Deterministic seed factory — same args always produce a byte-identical NormalizedJob, so the
// "unchanged re-ingest" seeds are trivially exact. Overrides express each behavior's single delta.
function job(externalId: string, overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    source: "greenhouse",
    externalId: jobId(externalId),
    title: "Senior Platform Engineer",
    companySlug: companySlug("acme"),
    locations: ["Remote - US"],
    remote: true,
    descriptionText: "Senior Platform Engineer description body",
    applyUrl: `https://example.test/${externalId}`,
    postedAt: null,
    ...overrides,
  };
}

// md5 hex over the JS mirror of the SQL normalization — the expected value for signatureSql output.
function md5hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

// Sentinel timestamps planted via direct UPDATE between upserts — DB now() cannot be faked, so
// exact-preservation / strict-advancement assertions hang off these instead of now()-vs-now().
const SENTINEL_2020 = new Date("2020-01-01T00:00:00Z");

// This file proves the Postgres SEMANTICS of the board-persistence pipeline in repos/jobs.ts:
// within-batch dedupe, batch splitting, NUL sanitization, canonical locations, the ON CONFLICT
// setWhere idempotency gate, the conditional embedding reset, the SQL-side content signature, the
// content guard (a failed hydrate writes nothing but a moved company_id), and the negative space
// (lifecycle/created_at/last_seen_at/raw columns this writer must NEVER touch).
// NOT this file's job: intended SQL TEXT + param binding (unit suites via render()/stubExecDb())
// and lifecycle close/revive transitions (repos/lifecycle.ts owns revival — see B11's comment).
describe("upsertCompany + upsertJobs — board persistence semantics (integration: real PGlite Postgres)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    await truncate(db, companies, jobs);
  });
  afterAll(async () => {
    // Optional-chained: if beforeAll's createTestDb() rejected, a bare close() would bury the real
    // failure under a secondary TypeError. Drains the WASM handle → clean Windows teardown.
    await close?.();
  });

  /** Read the single jobs row for an externalId, gated so the non-null index is provably safe. */
  async function jobRow(externalId: string) {
    const rows = await db.select().from(jobs).where(eq(jobs.externalId, jobId(externalId)));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  describe("upsertJobs — batch pipeline (dedupe, batching, sanitization, empty guard)", () => {
    it("collapses duplicate (source, externalId) rows before the INSERT — last occurrence wins", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");

      // Duplicates deliberately NOT adjacent, with differing titles between the duplicates.
      // Without the dedupe Map this single INSERT ... ON CONFLICT hits the same conflict key
      // twice and Postgres raises 21000 ("cannot affect row a second time") — the call throws.
      const res = await upsertJobs(db, companyId, [
        job("ext-1", { title: "Title A" }),
        job("ext-2", { title: "Other" }),
        job("ext-1", { title: "Title B" }),
      ]);
      // total reflects the DISTINCT count — a dedupe pass-through regression would report 3.
      expect(res).toEqual({ changed: 2, total: 2, contentMissing: 0 });

      const all = await db.select({ id: jobs.id }).from(jobs);
      expect(all).toHaveLength(2);
      // Last-wins: a keep-first dedupe regression would store 'Title A' instead.
      expect((await jobRow("ext-1")).title).toBe("Title B");
    });

    it("dedupes on (source, externalId), not externalId alone — one row per source survives", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");

      // IDENTICAL externalIds are the discriminating part: a key that drops source collapses
      // this pair in the Map (total 1, one row) before SQL ever runs.
      const res = await upsertJobs(db, companyId, [
        job("shared-1", { source: "greenhouse", title: "GH Role" }),
        job("shared-1", { source: "lever", title: "Lever Role" }),
      ]);
      expect(res).toEqual({ changed: 2, total: 2, contentMissing: 0 });

      const rows = await db
        .select({ source: jobs.source, externalId: jobs.externalId })
        .from(jobs)
        .orderBy(jobs.source);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.source).toBe("greenhouse");
      expect(rows[1]!.source).toBe("lever");
      expect(rows[0]!.externalId).toBe("shared-1");
      expect(rows[1]!.externalId).toBe("shared-1");
    });

    it("splits a 501-row board across batches and accumulates changed across slices", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");

      // 501 = UPSERT_BATCH_SIZE (500, non-exported) + 1: forces exactly two slices. Tiny per-row
      // strings keep the ~12-binds/row batch fast. HONEST LIMIT: a single unbatched 501-row
      // INSERT would still SUCCEED under PGlite (~6k binds < 65535), so this proves slice
      // boundary + accumulation, NOT the param-ceiling rationale for batching.
      const board = Array.from({ length: 501 }, (_, i) =>
        job(`ext-${i}`, { title: `t${i}`, descriptionText: "d", locations: [], applyUrl: "u" }),
      );
      const res = await upsertJobs(db, companyId, board);
      // `changed += updated.length` regressing to `=` would report 1 (second batch only).
      expect(res).toEqual({ changed: 501, total: 501, contentMissing: 0 });

      const all = await db.select({ id: jobs.id }).from(jobs);
      // A loop that only runs the first slice leaves count at 500.
      expect(all).toHaveLength(501);
      // The slice-boundary pair: an off-by-one in slice bounds drops one of these rows.
      expect((await jobRow("ext-499")).title).toBe("t499");
      expect((await jobRow("ext-500")).title).toBe("t500");
    });

    it("strips U+0000 from title, description, locations, and applyUrl — the INSERT survives with adjacent characters joined", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");

      // NUL is runtime-constructed (./sql) — never an escape sequence in this source file. One
      // NUL per field makes each of the four .replaceAll(NUL, "") strips independently
      // load-bearing: deleting any one lets Postgres reject the whole INSERT (22021-class).
      const res = await upsertJobs(db, companyId, [
        job("ext-nul", {
          title: `Sen${NUL}ior Engineer`,
          descriptionText: `body${NUL}text`,
          locations: [`Aus${NUL}tin`],
          applyUrl: `https://x.test/a${NUL}b`,
        }),
      ]);
      expect(res).toEqual({ changed: 1, total: 1, contentMissing: 0 });

      const row = await jobRow("ext-nul");
      // Joined equality (not just "no throw") catches a strip-to-space regression.
      expect(row.title).toBe("Senior Engineer");
      expect(row.descriptionText).toBe("bodytext");
      expect(row.locations).toEqual(["Austin"]);
      expect(row.applyUrl).toBe("https://x.test/ab");
    });

    it("writes locations in canonical sorted order — a reordered re-ingest is a no-op", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");

      // Deliberately unsorted seed: a pre-sorted one would pass even with .sort() deleted.
      await upsertJobs(db, companyId, [job("ext-loc", { locations: ["Zurich", "Austin", "Berlin"] })]);
      // Dropping .sort() stores the raw input order.
      expect((await jobRow("ext-loc")).locations).toEqual(["Austin", "Berlin", "Zurich"]);

      // setWhere compares locations as ORDER-SENSITIVE jsonb: without canonical sorting this
      // reorder would look "changed" every ingest (spurious churn), flipping changed to 1.
      const res = await upsertJobs(db, companyId, [
        job("ext-loc", { locations: ["Berlin", "Zurich", "Austin"] }),
      ]);
      expect(res).toEqual({ changed: 0, total: 1, contentMissing: 0 });
      expect((await jobRow("ext-loc")).locations).toEqual(["Austin", "Berlin", "Zurich"]);
    });

    it("stamps content_signature on insert as md5 of the normalized title + description", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");

      // Mixed case + runs of ASCII whitespace (space/tab/LF, runtime-built — no escapes in
      // source) + leading/trailing whitespace, so EVERY normalization stage (lower,
      // [[:space:]]+ collapse, btrim) transforms something — a lowercase single-spaced seed
      // would survive any single stage being deleted. ASCII-only: JS \s is broader than POSIX
      // [[:space:]] (NBSP diverges — the F8 poison-row class).
      const TAB = String.fromCharCode(9);
      const LF = String.fromCharCode(10);
      // NO trailing space on the title: with one, the [[:space:]]+ collapse makes title||chr(10)||desc
      // and title||desc normalize to the SAME string, silently un-proving the chr(10) separator (the
      // guard against gluing 'Engineer'+'Build' into one token and splitting signature groups).
      const title = "  Senior   PLATFORM Engineer";
      const desc = `Build${TAB}things${LF}  FAST  `;
      await upsertJobs(db, companyId, [job("ext-sig", { title, descriptionText: desc })]);

      // Exact hex vs the JS mirror: any dropped normalization stage (or the chr(10) separator)
      // changes the md5 input and mismatches.
      const expected = md5hex(normalizeSignatureText(title, desc));
      expect((await jobRow("ext-sig")).contentSignature).toBe(expected);
    });

    it("returns zeros for an empty list without issuing SQL", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");

      // Deleting the empty guard reaches drizzle's .values([]) which throws — VALUES with zero
      // tuples is invalid SQL.
      const res = await upsertJobs(db, companyId, []);
      expect(res).toEqual({ changed: 0, total: 0, contentMissing: 0 });
      expect(await db.select({ id: jobs.id }).from(jobs)).toHaveLength(0);
    });
  });

  describe("upsertJobs — conflict-update semantics (setWhere gate, embedding reset, negative space)", () => {
    it("skips a byte-identical re-ingest entirely — changed 0 and updated_at frozen", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
      await upsertJobs(db, companyId, [job("ext-a"), job("ext-b")]);
      // Plant a sentinel so the timestamp half is non-vacuous — "two now() values are close"
      // would pass under any mutation.
      await db.update(jobs).set({ updatedAt: SENTINEL_2020 });

      const res = await upsertJobs(db, companyId, [job("ext-a"), job("ext-b")]);
      // Deleting the whole setWhere makes the DO UPDATE unconditional: changed becomes 2.
      expect(res).toEqual({ changed: 0, total: 2, contentMissing: 0 });

      const rows = await db.select({ updatedAt: jobs.updatedAt }).from(jobs);
      expect(rows).toHaveLength(2);
      // An unconditional update would also stamp updated_at = now(), destroying the sentinel.
      expect(rows[0]!.updatedAt).toEqual(SENTINEL_2020);
      expect(rows[1]!.updatedAt).toEqual(SENTINEL_2020);
    });

    it("NULLs the embedding and advances updated_at when the title changes", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
      await upsertJobs(db, companyId, [job("ext-e", { title: "Alpha Role" })]);
      const before = await jobRow("ext-e");
      // The row demonstrably HAS a vector before the re-upsert, so a surviving vector is
      // unambiguous evidence the WHEN ... THEN NULL branch was deleted.
      expect(await writeJobEmbeddings(db, [{ id: before.id, embedding: oneHot(0) }])).toBe(1);
      // writeJobEmbeddings' return falls back to chunk.length on an empty RETURNING — assert the
      // precondition directly so the toBeNull below can never pass off a silently no-oped write.
      expect((await jobRow("ext-e")).embedding).not.toBeNull();
      await db.update(jobs).set({ updatedAt: SENTINEL_2020 }).where(eq(jobs.id, before.id));

      const res = await upsertJobs(db, companyId, [job("ext-e", { title: "Beta Role" })]);
      expect(res).toEqual({ changed: 1, total: 1, contentMissing: 0 });

      const after = await jobRow("ext-e");
      expect(after.title).toBe("Beta Role");
      // Content changed → backfill must re-embed: a kept vector means stale-prose retrieval.
      expect(after.embedding).toBeNull();
      // Sentinel makes this non-vacuous: deleting `updatedAt: now()` from the set leaves 2020.
      expect(after.updatedAt.getTime()).toBeGreaterThan(SENTINEL_2020.getTime());
    });

    it("NULLs the embedding on a description-only change — the description disjunct fires alone", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
      await upsertJobs(db, companyId, [job("ext-d")]);
      const before = await jobRow("ext-d");
      expect(await writeJobEmbeddings(db, [{ id: before.id, embedding: oneHot(3) }])).toBe(1);
      // Same precondition pin as the title-change test — the vector demonstrably landed.
      expect((await jobRow("ext-d")).embedding).not.toBeNull();

      // Title identical, so ONLY the descriptionText disjunct can fire in both the CASE and
      // setWhere — deleting either mirror flips one of these assertions.
      const res = await upsertJobs(db, companyId, [
        job("ext-d", { descriptionText: "A freshly rewritten body" }),
      ]);
      // Deleting the descriptionText disjunct from setWhere makes changed 0.
      expect(res).toEqual({ changed: 1, total: 1, contentMissing: 0 });

      const after = await jobRow("ext-d");
      expect(after.descriptionText).toBe("A freshly rewritten body");
      // Deleting the descriptionText disjunct from nullIfContentChanged leaves the vector.
      expect(after.embedding).toBeNull();
    });

    it("keeps the existing embedding when only remote flips — non-content churn never wipes vectors", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
      await upsertJobs(db, companyId, [job("ext-r", { remote: true })]);
      const before = await jobRow("ext-r");
      expect(await writeJobEmbeddings(db, [{ id: before.id, embedding: oneHot(7) }])).toBe(1);

      const res = await upsertJobs(db, companyId, [job("ext-r", { remote: false })]);
      // MANDATORY guard: the DO UPDATE must actually fire (remote disjunct) — without it every
      // preservation assertion below passes vacuously under any mutation.
      expect(res).toEqual({ changed: 1, total: 1, contentMissing: 0 });

      const after = await jobRow("ext-r");
      expect(after.remote).toBe(false);
      // excluded.embedding is ALWAYS NULL (VALUES omits the column): `ELSE excluded.embedding`
      // — the historical near-miss — or a CASE without ELSE would wipe the vector right here.
      expect(after.embedding).not.toBeNull();
      expect(after.embedding).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(after.embedding![7]!).toBeCloseTo(1, 5);
    });

    it("recomputes content_signature from excluded.* on a content change — never a stale snapshot", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
      const desc = "Shared description body";
      await upsertJobs(db, companyId, [job("ext-s", { title: "Alpha Role", descriptionText: desc })]);
      await upsertJobs(db, companyId, [job("ext-s", { title: "Beta Role", descriptionText: desc })]);

      const row = await jobRow("ext-s");
      // Deleting the contentSignature entry from conflictUpdate.set freezes the v1 hash — the
      // CRUX don't-snapshot-signature class. Asserting "is some md5 hex" would pass either way.
      expect(row.contentSignature).toBe(md5hex(normalizeSignatureText("Beta Role", desc)));
      expect(row.contentSignature).not.toBe(md5hex(normalizeSignatureText("Alpha Role", desc)));
    });

    it("excludes posted_at from the change test but refreshes it when a real change fires", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
      const jan = new Date("2026-01-01T00:00:00Z");
      const feb = new Date("2026-02-01T00:00:00Z");
      const mar = new Date("2026-03-01T00:00:00Z");
      await upsertJobs(db, companyId, [job("ext-p", { postedAt: jan })]);

      // (a) postedAt-only delta: adding posted_at to setWhere (the adapter derives it from a
      // churning updated_at, so comparing it makes every re-fetch look "changed") flips this to 1.
      const resA = await upsertJobs(db, companyId, [job("ext-p", { postedAt: feb })]);
      expect(resA).toEqual({ changed: 0, total: 1, contentMissing: 0 });
      // The set never ran, so the stored stamp is still January (not February).
      expect((await jobRow("ext-p")).postedAt).toEqual(jan);

      // (b) real change (title) alongside a new postedAt: deleting `postedAt: excluded.posted_at`
      // from the set leaves the stale January stamp on a genuinely changed row.
      const resB = await upsertJobs(db, companyId, [
        job("ext-p", { title: "Changed Title", postedAt: mar }),
      ]);
      expect(resB).toEqual({ changed: 1, total: 1, contentMissing: 0 });
      expect((await jobRow("ext-p")).postedAt).toEqual(mar);
    });

    it("moves a job to a new company when only companyId differs — the disjunct and set entry are both live", async () => {
      const idA = await upsertCompany(db, companySlug("acme"), "greenhouse");
      const idB = await upsertCompany(db, companySlug("beta-inc"), "greenhouse");
      await upsertJobs(db, idA, [job("ext-m")]);

      // Byte-identical job, different companyId param: ONLY the companyId disjunct can fire.
      // Deleting it from setWhere → changed 0; deleting the set entry alone → changed 1 but the
      // row stays on company A (the column assertion below).
      const res = await upsertJobs(db, idB, [job("ext-m")]);
      expect(res).toEqual({ changed: 1, total: 1, contentMissing: 0 });

      const rows = await db.select({ companyId: jobs.companyId }).from(jobs);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.companyId).toBe(idB);
    });

    it("never revives a closed job — lifecycle_state, closed_at, and consecutive_absences survive a firing update", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
      await upsertJobs(db, companyId, [job("ext-c", { title: "Alpha Role" })]);
      const closedSentinel = new Date("2026-01-01T00:00:00Z");
      await db
        .update(jobs)
        .set({ lifecycleState: "closed", closedAt: closedSentinel, consecutiveAbsences: 3 })
        .where(eq(jobs.externalId, jobId("ext-c")));

      // The FORCED title change is what makes this non-vacuous: with unchanged content setWhere
      // skips the row and any lifecycle-writing mutation would be invisible.
      const res = await upsertJobs(db, companyId, [job("ext-c", { title: "Beta Role" })]);
      expect(res).toEqual({ changed: 1, total: 1, contentMissing: 0 });

      const row = await jobRow("ext-c");
      expect(row.title).toBe("Beta Role"); // proves the set block actually ran
      // Revival is EXCLUSIVELY repos/lifecycle.ts: a lifecycle_state='active' write here would
      // revive zombies on every re-ingest.
      expect(row.lifecycleState).toBe("closed");
      // The prune clock: a closed_at reset (NULL or now()) on every re-ingest silently restarts
      // it and closed rows never get pruned — the Neon-bloat damage class.
      expect(row.closedAt).toEqual(closedSentinel);
      // A streak reset here would defeat sweepLifecycle's absence hysteresis.
      expect(row.consecutiveAbsences).toBe(3);
    });

    it("preserves created_at and last_seen_at through a firing update while updated_at advances", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
      await upsertJobs(db, companyId, [job("ext-t", { title: "Alpha Role" })]);
      // Defaults are now(), so without these sentinels ANY added createdAt/lastSeenAt write
      // would be indistinguishable from the default.
      await db
        .update(jobs)
        .set({ createdAt: SENTINEL_2020, lastSeenAt: SENTINEL_2020, updatedAt: SENTINEL_2020 })
        .where(eq(jobs.externalId, jobId("ext-t")));

      const res = await upsertJobs(db, companyId, [job("ext-t", { title: "Beta Role" })]);
      expect(res).toEqual({ changed: 1, total: 1, contentMissing: 0 }); // the set demonstrably ran

      const row = await jobRow("ext-t");
      // created_at is first-seen — an added createdAt write in conflictUpdate.set destroys it.
      expect(row.createdAt).toEqual(SENTINEL_2020);
      // last_seen_at is OWNED by lifecycle.markJobsPresent, never this writer.
      expect(row.lastSeenAt).toEqual(SENTINEL_2020);
      // raw is DEPRECATED write-only debug data — writing it again is byte-for-byte the Neon 512MB
      // bloat outage. NormalizedJob no longer carries a raw, so the column must stay NULL.
      expect(row.raw).toBeNull();
      expect(row.updatedAt.getTime()).toBeGreaterThan(SENTINEL_2020.getTime());
    });
  });

  describe("upsertJobs — content guard (a failed hydrate never overwrites stored content)", () => {
    // A contentMissing job is what runAdapter returns for a posting whose detail fetch failed: list-level
    // fields + a placeholder "" description. These call upsertJobs DIRECTLY (no runIngestion) — the guard
    // lives in this single choke point, so every caller is protected, not just the ingestion loop.
    const missing = (externalId: string, list: Partial<NormalizedJob> = {}): NormalizedJob =>
      job(externalId, { title: "List-level title", descriptionText: "", ...list, contentMissing: true });

    it("never touches a stored row on the same board — content, embedding, updated_at all survive", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
      await upsertJobs(db, companyId, [job("ext-k")]);
      const stored = await jobRow("ext-k");
      expect(await writeJobEmbeddings(db, [{ id: stored.id, embedding: oneHot(5) }])).toBe(1);
      await db.update(jobs).set({ updatedAt: SENTINEL_2020 }).where(eq(jobs.id, stored.id));
      const before = await jobRow("ext-k");
      expect(before.embedding).not.toBeNull(); // precondition: there IS a vector to lose

      // The title differs too, so a write of ANY kind would land (setWhere fires on title/description).
      const res = await upsertJobs(db, companyId, [missing("ext-k")]);
      expect(res).toEqual({ changed: 0, total: 0, contentMissing: 1 });

      // Byte-identical row: nothing overwritten, the embedding NOT NULLed (no paid re-embed), the
      // signature NOT recomputed from the title alone (no F1 de-dupe collapse), updated_at frozen — and
      // the company_id move only rewrites a row that actually moved boards.
      expect(await jobRow("ext-k")).toEqual(before);
    });

    it("moves a stored row to the board listing it now (company_id only) — never its content or other fields", async () => {
      const oldBoard = await upsertCompany(db, companySlug("acme"), "greenhouse");
      const newBoard = await upsertCompany(db, companySlug("acme-new"), "greenhouse");
      await upsertJobs(db, oldBoard, [job("ext-mv", { applyUrl: "https://real.test/apply" })]);
      const stored = await jobRow("ext-mv");
      expect(await writeJobEmbeddings(db, [{ id: stored.id, embedding: oneHot(2) }])).toBe(1);
      await db.update(jobs).set({ updatedAt: SENTINEL_2020 }).where(eq(jobs.id, stored.id));
      const before = await jobRow("ext-mv");

      // The posting moved boards and its detail fetch failed (placeholders), list fields differing too.
      const res = await upsertJobs(db, newBoard, [
        missing("ext-mv", {
          locations: ["Zurich"],
          remote: false,
          applyUrl: "https://placeholder.test/reconstructed",
        }),
      ]);

      expect(res).toEqual({ changed: 0, total: 0, contentMissing: 1 });
      // ONLY company_id (+ updated_at) changed, so the board listing it now owns it and its old board's
      // sweep can't close it; everything else — content, locations, remote, the real apply_url — as stored.
      expect(await jobRow("ext-mv")).toEqual({
        ...before,
        companyId: newBoard,
        updatedAt: expect.any(Date) as Date,
      });
      expect((await jobRow("ext-mv")).updatedAt.getTime()).toBeGreaterThan(SENTINEL_2020.getTime());
    });

    it("moves ONLY the listed (source, external_id) rows — never another board's row, nor the same id on another source", async () => {
      const oldBoard = await upsertCompany(db, companySlug("acme"), "greenhouse");
      const newBoard = await upsertCompany(db, companySlug("acme-new"), "greenhouse");
      const otherBoard = await upsertCompany(db, companySlug("unrelated"), "greenhouse");
      const leverBoard = await upsertCompany(db, companySlug("acme"), "lever");
      await upsertJobs(db, oldBoard, [job("x-1")]); // the listed posting: must move
      await upsertJobs(db, otherBoard, [job("y-9")]); // same source, unrelated board: must stay
      await upsertJobs(db, leverBoard, [job("x-1", { source: "lever" })]); // same id, other source: must stay

      await upsertJobs(db, newBoard, [missing("x-1")]); // greenhouse x-1, detail failed

      const boardOf = async (source: "greenhouse" | "lever", externalId: string) =>
        (
          await db
            .select({ companyId: jobs.companyId, source: jobs.source })
            .from(jobs)
            .where(eq(jobs.externalId, jobId(externalId)))
        ).find((r) => r.source === source)!.companyId;
      expect(await boardOf("greenhouse", "x-1")).toBe(newBoard);
      expect(await boardOf("greenhouse", "y-9")).toBe(otherBoard);
      expect(await boardOf("lever", "x-1")).toBe(leverBoard);
    });

    it("moveToListingBoard with an EMPTY list touches nothing (no pairs must never mean every row)", async () => {
      const boardA = await upsertCompany(db, companySlug("acme"), "greenhouse");
      const boardB = await upsertCompany(db, companySlug("beta-inc"), "greenhouse");
      await upsertJobs(db, boardA, [job("e-1"), job("e-2")]);
      const before = await db.select().from(jobs).orderBy(jobs.id);

      await moveToListingBoard(db, boardB, []);

      expect(await db.select().from(jobs).orderBy(jobs.id)).toEqual(before);
    });

    it("does not insert a brand-new contentMissing posting, while its board's complete postings still land", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");

      const res = await upsertJobs(db, companyId, [missing("ext-new"), job("ext-ok")]);

      expect(res).toEqual({ changed: 1, total: 1, contentMissing: 1 });
      const rows = await db.select({ externalId: jobs.externalId }).from(jobs);
      expect(rows.map((r) => r.externalId)).toEqual(["ext-ok"]);
    });

    it("an all-missing batch issues no INSERT (and doesn't throw on the empty VALUES)", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");

      const res = await upsertJobs(db, companyId, [missing("ext-1"), missing("ext-2")]);

      expect(res).toEqual({ changed: 0, total: 0, contentMissing: 2 });
      expect(await db.select({ id: jobs.id }).from(jobs)).toHaveLength(0);
    });

    it("a duplicate id's copy WITH content beats its contentMissing copy in either order, and counts distinct ids", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");

      // dup-a: missing first, content last (plain last-wins would also pass this one).
      // dup-b: content first, missing LAST — plain last-wins would drop dup-b's content (NOT written) and
      //        count it missing; the precedence rule writes it and doesn't count it.
      // dup-c: missing twice — one distinct posting, counted ONCE.
      const res = await upsertJobs(db, companyId, [
        missing("dup-a"),
        job("dup-a", { descriptionText: "A body" }),
        job("dup-b", { descriptionText: "B body" }),
        missing("dup-b"),
        missing("dup-c"),
        missing("dup-c"),
      ]);

      expect(res).toEqual({ changed: 2, total: 2, contentMissing: 1 });
      expect((await jobRow("dup-a")).descriptionText).toBe("A body");
      expect((await jobRow("dup-b")).descriptionText).toBe("B body");
      const dupC = await db.select().from(jobs).where(eq(jobs.externalId, jobId("dup-c")));
      expect(dupC).toHaveLength(0);
    });
  });

  describe("upsertJobs — empty-description guard (any source: a blank body never replaces real text)", () => {
    const TAB = String.fromCharCode(9);
    const LF = String.fromCharCode(10);

    it.each([
      ["an empty string", ""],
      ["whitespace only", `  ${LF}${TAB} `],
    ])("keeps the stored description, signature, embedding and updated_at over %s", async (_l, blank) => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
      await upsertJobs(db, companyId, [job("ext-b")]);
      const stored = await jobRow("ext-b");
      expect(await writeJobEmbeddings(db, [{ id: stored.id, embedding: oneHot(4) }])).toBe(1);
      await db.update(jobs).set({ updatedAt: SENTINEL_2020 }).where(eq(jobs.id, stored.id));
      const before = await jobRow("ext-b");

      // A plain job (no contentMissing flag): e.g. an inline-content board momentarily serving no body.
      const res = await upsertJobs(db, companyId, [job("ext-b", { descriptionText: blank })]);

      // NOT changed: the kept text equals the stored one, so setWhere doesn't fire at all.
      expect(res).toEqual({ changed: 0, total: 1, contentMissing: 0 });
      expect(await jobRow("ext-b")).toEqual(before);
    });

    it("a title change in the same row still applies — signature and embedding follow the title, not the blank", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
      const body = "Senior Platform Engineer description body";
      await upsertJobs(db, companyId, [job("ext-t2", { descriptionText: body })]);
      const stored = await jobRow("ext-t2");
      expect(await writeJobEmbeddings(db, [{ id: stored.id, embedding: oneHot(6) }])).toBe(1);

      const res = await upsertJobs(db, companyId, [
        job("ext-t2", { title: "Principal Platform Engineer", descriptionText: "" }),
      ]);

      expect(res).toEqual({ changed: 1, total: 1, contentMissing: 0 });
      const after = await jobRow("ext-t2");
      expect(after.title).toBe("Principal Platform Engineer");
      expect(after.descriptionText).toBe(body); // still the stored text
      // The signature is the NEW title + the KEPT body — never the title alone.
      expect(after.contentSignature).toBe(
        md5hex(normalizeSignatureText("Principal Platform Engineer", body)),
      );
      expect(after.embedding).toBeNull(); // the title DID change: re-embed is right
    });

    it("a blank over a blank stored body is written as given; a NEW posting is inserted with \"\"", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
      await upsertJobs(db, companyId, [job("ext-e", { descriptionText: "" })]);

      const res = await upsertJobs(db, companyId, [
        job("ext-e", { descriptionText: "  " }),
        job("ext-new", { descriptionText: "" }),
      ]);

      // ext-e: "" → "  " is a (harmless) whitespace change, so it is written — the guard only fires when
      // there is real text to protect. ext-new: inserted as given (today's behaviour for a first fetch).
      expect(res).toMatchObject({ total: 2 });
      expect((await jobRow("ext-e")).descriptionText).toBe("  "); // the guard only protects REAL text
      expect((await jobRow("ext-new")).descriptionText).toBe("");
    });

    it("a real (non-blank) new description still replaces the stored one", async () => {
      const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
      await upsertJobs(db, companyId, [job("ext-r2")]);

      const res = await upsertJobs(db, companyId, [job("ext-r2", { descriptionText: "Rewritten" })]);

      expect(res).toEqual({ changed: 1, total: 1, contentMissing: 0 });
      expect((await jobRow("ext-r2")).descriptionText).toBe("Rewritten");
    });
  });

  describe("upsertCompany — (slug, source) get-or-create", () => {
    it("returns the existing id on conflict without clobbering active, metadata, or updated_at", async () => {
      const idA = await upsertCompany(db, companySlug("acme"), "greenhouse");
      // Pre-mutate real fields to sentinels so any conflict-path clobber is observable — INCLUDING
      // the probe columns: a "reset the probe streak when discovery re-finds a board" refactor
      // writing them on conflict would zero deactivateStale's staleness clock on every discovery
      // pass (the capped-board-zombie class), invisibly so if they sat at their defaults.
      await db
        .update(companies)
        .set({
          active: false,
          metadata: { name: "Acme" },
          updatedAt: SENTINEL_2020,
          consecutiveProbeFailures: 2,
          lastProbedAt: SENTINEL_2020,
          lastLiveAt: SENTINEL_2020,
          lastIngestedAt: SENTINEL_2020,
        })
        .where(eq(companies.id, idA));

      // Removing the no-op set (i.e. onConflictDoNothing) makes RETURNING empty and this throw.
      const again = await upsertCompany(db, companySlug("acme"), "greenhouse");
      expect(again).toBe(idA);

      const rows = await db.select().from(companies);
      // A broken conflict target would insert a duplicate row.
      expect(rows).toHaveLength(1);
      // The conflict write must stay a NO-OP: real-field writes on conflict destroy these.
      expect(rows[0]!.active).toBe(false);
      expect(rows[0]!.metadata).toEqual({ name: "Acme" });
      // companies.updated_at has no $onUpdate — only an explicit (regressed) write could move it.
      expect(rows[0]!.updatedAt).toEqual(SENTINEL_2020);
      expect(rows[0]!.consecutiveProbeFailures).toBe(2);
      expect(rows[0]!.lastProbedAt).toEqual(SENTINEL_2020);
      expect(rows[0]!.lastLiveAt).toEqual(SENTINEL_2020);
      expect(rows[0]!.lastIngestedAt).toEqual(SENTINEL_2020);
    });

    it("treats identity as (slug, source) — the same slug on another source creates a new row", async () => {
      // IDENTICAL slugs are the discriminating part: if identity collapsed to slug alone, the
      // second call conflicts into the first row (same id, count 1).
      const gh = await upsertCompany(db, companySlug("acme"), "greenhouse");
      const lv = await upsertCompany(db, companySlug("acme"), "lever");
      expect(lv).not.toBe(gh);
      expect(await db.select({ id: companies.id }).from(companies)).toHaveLength(2);
    });

    // companies_source_lower_slug_uq (migration 0025): ON CONFLICT (slug, source) can't absorb a conflict on
    // it, so a case variant FAILS instead of adding a second row for one board.
    it.each([
      ["smartrecruiters", "BoschGroup", "boschgroup"],
      ["ashby", "Mapbox", "MAPBOX"],
    ] as const)(
      "%s: a case variant of a stored slug throws a plain, named error and inserts nothing",
      async (source, stored, variant) => {
        const id = await upsertCompany(db, companySlug(stored), source);

        const err: unknown = await upsertCompany(db, companySlug(variant), source).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe(
          `${source}:"${variant}" is a case variant of an existing ${source} company (${source} board ids ` +
            `ignore case; companies_source_lower_slug_uq). That board is already tracked: use its stored slug.`,
        );
        expect((err as Error).cause).toBeDefined(); // the driver's unique violation stays reachable

        const rows = await db.select({ id: companies.id, slug: companies.slug }).from(companies);
        expect(rows).toEqual([{ id, slug: stored }]);
        // The stored casing itself is still get-or-create.
        expect(await upsertCompany(db, companySlug(stored), source)).toBe(id);
      },
    );

    it("leaves case-SENSITIVE sources exact: Lever `Acme` and `acme` are two boards", async () => {
      const upper = await upsertCompany(db, companySlug("Acme"), "lever");
      const lower = await upsertCompany(db, companySlug("acme"), "lever");
      expect(lower).not.toBe(upper);
      expect(await db.select({ id: companies.id }).from(companies)).toHaveLength(2);
    });
  });

  describe("listCompanies — filters and id-keyset", () => {
    it("orders by id and honors source, activeOnly, and afterId+limit independently", async () => {
      const c1 = await upsertCompany(db, companySlug("a1"), "greenhouse");
      const c2 = await upsertCompany(db, companySlug("a2"), "lever");
      const c3 = await upsertCompany(db, companySlug("a3"), "greenhouse");
      // The inactive row exists ONLY to make the activeOnly clause load-bearing.
      await db.update(companies).set({ active: false }).where(eq(companies.id, c3));
      // Relocate c2's heap tuple (a same-value UPDATE still writes a new tuple version at the heap
      // end) so physical order becomes [c1, c3, c2] — without this, heap order accidentally equals
      // id order and every assertion below stays green with .orderBy(companies.id) deleted.
      await db.update(companies).set({ active: true }).where(eq(companies.id, c2));

      // Unfiltered: full set in id order (dropping orderBy scrambles under other plans).
      const all = await listCompanies(db);
      expect(all.map((r) => r.id)).toEqual([c1, c2, c3]);

      // The lever row leaks in if the eq(source) clause is dropped.
      const gh = await listCompanies(db, { source: "greenhouse" });
      expect(gh.map((r) => r.id)).toEqual([c1, c3]);

      // The deactivated row leaks in if the eq(active) clause is dropped.
      const active = await listCompanies(db, { activeOnly: true });
      expect(active.map((r) => r.id)).toEqual([c1, c2]);

      // Keyset: dropping gt(id), orderBy, or limit each changes this slice from exactly [c2].
      const page = await listCompanies(db, { afterId: c1, limit: 1 });
      expect(page).toHaveLength(1);
      expect(page[0]!.id).toBe(c2);
    });
  });
});
