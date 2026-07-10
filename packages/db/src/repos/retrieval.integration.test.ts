import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  retrieveCandidatesForProfile,
  upsertCompany,
  upsertJobs,
  writeJobEmbeddings,
} from "@opusfinder/db/repos";
import { jobs } from "@opusfinder/db/schema";
import { companySlug, jobId, type NormalizedJob } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";
import { blend, oneHot } from "@test/db/vectors";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One seeded job: content + geo + freshness + (optional) vector. Omitting `embedding` leaves the
 *  row NULL-embedded — writeJobEmbeddings is simply never called for it. */
interface SeedSpec {
  externalId: string;
  title: string;
  description?: string;
  locations?: string[];
  remote?: boolean;
  postedAt?: Date | null;
  embedding?: number[];
}

// Deterministic seed factory — real repo writer input, never a hand-rolled INSERT. The default
// description derives from the title so two specs sharing a title are byte-identical content
// (the B15 cross-post seed relies on that for an identical SQL-computed content_signature).
function toJob(spec: SeedSpec): NormalizedJob {
  return {
    source: "greenhouse",
    externalId: jobId(spec.externalId),
    title: spec.title,
    companySlug: companySlug("acme"),
    locations: spec.locations ?? ["Remote - US"],
    remote: spec.remote ?? true,
    descriptionText: spec.description ?? `${spec.title} description body`,
    applyUrl: `https://example.test/${spec.externalId}`,
    postedAt: spec.postedAt ?? null,
    raw: {},
  };
}

// This file proves the digest retrieval read path (retrieveCandidatesForProfile) under REAL Postgres
// semantics: the SQL predicates (embedding IS NOT NULL, lifecycle_state='active', the COALESCE
// recency window, the id/signature anti-joins), `<=>` cosine ORDER BY deciding LIMIT survival, and
// the app-side sort → geo/exclusion post-filters → signature collapse → trim pipeline, plus the
// raw-row → JobCandidate mapping seam. NOT this file's job: the geoMatches truth table
// (location-mode.test.ts) and collapseBySignature's unit surface (content-signature.test.ts) — each
// gets exactly ONE wiring probe here; SQL TEXT + param binding stay with the unit render() seams.
describe("retrieveCandidatesForProfile — SQL filter + cosine rank + post-filter pipeline (integration: real PGlite semantics)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  beforeEach(async () => {
    // Truncate ONLY the tables this file touches; RESTART IDENTITY keeps seeded ids deterministic
    // (several seeds assert rank-1 identity and would cross-contaminate otherwise).
    await db.execute(sql`TRUNCATE TABLE companies, jobs RESTART IDENTITY CASCADE`);
  });
  afterAll(async () => {
    // Optional-chained: if beforeAll's createTestDb() rejected, a bare close() would bury the real
    // failure under a secondary TypeError. Drains the WASM handle → clean Windows teardown.
    await close?.();
  });

  /** Seed one company + its jobs through the REAL writers (upsertCompany/upsertJobs/
   *  writeJobEmbeddings), returning job ids in SPEC ORDER — read back by external_id, never
   *  inferred from insert order. A single upsertJobs batch assigns serial ids (and heap
   *  positions) in VALUES order, so "inserted farthest-first" seeds hold by construction. */
  async function seedBoard(specs: SeedSpec[]): Promise<number[]> {
    const companyId = await upsertCompany(db, companySlug("acme"), "greenhouse");
    const { total } = await upsertJobs(db, companyId, specs.map(toJob));
    expect(total).toBe(specs.length);
    const rows = await db.select({ id: jobs.id, externalId: jobs.externalId }).from(jobs);
    const byExternalId = new Map<string, number>(rows.map((r) => [r.externalId as string, r.id]));
    const ids = specs.map((s) => {
      const id = byExternalId.get(s.externalId);
      if (id === undefined) throw new Error(`seedBoard: job ${s.externalId} missing after upsert`);
      return id;
    });
    const embeds = specs.flatMap((s, i) =>
      s.embedding ? [{ id: ids[i]!, embedding: s.embedding }] : [],
    );
    if (embeds.length > 0) await writeJobEmbeddings(db, embeds);
    return ids;
  }

  // B1
  it("orders candidates by ascending cosine distance — insertion/id order is the exact reverse, so any id/heap-order fallback fails", async () => {
    // Inserted FARTHEST-FIRST: ids ascend C < B < A while distance descends 1.0 > 0.4 > 0.
    const seeded = await seedBoard([
      { externalId: "far", title: "Embedded Firmware Engineer", embedding: oneHot(1) },
      { externalId: "mid", title: "Data Platform Engineer", embedding: blend(0.6, 0.8) },
      { externalId: "near", title: "Senior Platform Engineer", embedding: oneHot(0) },
    ]);
    const result = await retrieveCandidatesForProfile(db, oneHot(0), { limit: 10 });
    expect(result).toHaveLength(3);
    // If the app sort's distance key (`a.distance - b.distance`) is removed, the id tiebreak alone
    // returns [C, B, A]; three strictly distinct distances mean no tie can mask the regression.
    expect(result.map((c) => c.id)).toEqual([seeded[2]!, seeded[1]!, seeded[0]!]);
    expect(result[0]!.distance).toBeCloseTo(0, 5);
    expect(result[1]!.distance).toBeCloseTo(0.4, 5);
    expect(result[2]!.distance).toBeCloseTo(1.0, 5);
    // Strictly ascending — a stable-but-wrong ordering can't sneak past equal-distance noise.
    expect(result[0]!.distance).toBeLessThan(result[1]!.distance);
    expect(result[1]!.distance).toBeLessThan(result[2]!.distance);
  });

  // B2
  it("lets the SQL ORDER BY decide which rows SURVIVE the fetch LIMIT — the nearest row wins even when fetchLimit < pool", async () => {
    // FAR inserted first → earlier heap position; fetchLimit = 1*1 = 1 < pool of 2.
    const seeded = await seedBoard([
      { externalId: "far", title: "Embedded Firmware Engineer", embedding: oneHot(1) },
      { externalId: "near", title: "Senior Platform Engineer", embedding: oneHot(0) },
    ]);
    // Harden the heap argument by construction (B10-style): rewrite NEAR's tuple so its newest
    // version lands physically LAST — FAR is then guaranteed the first seq-scan row regardless of
    // the writeJobEmbeddings UPDATE's own row-processing order, and an ORDER-BY-dropped LIMIT 1
    // deterministically returns FAR (red), never NEAR by plan accident.
    await db.execute(sql`UPDATE ${jobs} SET updated_at = now() WHERE id = ${seeded[1]!}`);
    const result = await retrieveCandidatesForProfile(db, oneHot(0), { limit: 1, overFetch: 1 });
    expect(result).toHaveLength(1);
    // Dropping SQL `ORDER BY distance` makes the seq scan feed LIMIT 1 its first physical row —
    // FAR. The app-side sort can only reorder survivors, never repair which row survived.
    expect(result[0]!.id).toBe(seeded[1]!);
    expect(result[0]!.distance).toBeCloseTo(0, 5);
  });

  // B3
  it("drops jobs older than the default 14-day recency window even when they are the nearest neighbour", async () => {
    // OLD is deliberately the NEAREST vector: if the recency predicate is dropped it wins rank 1.
    // 30d vs 1d offsets give huge margin against test-runtime now() skew.
    const seeded = await seedBoard([
      {
        externalId: "old",
        title: "Senior Platform Engineer",
        postedAt: new Date(Date.now() - 30 * DAY_MS),
        embedding: oneHot(0),
      },
      {
        externalId: "fresh",
        title: "Data Platform Engineer",
        postedAt: new Date(Date.now() - 1 * DAY_MS),
        embedding: blend(0.6, 0.8),
      },
    ]);
    const result = await retrieveCandidatesForProfile(db, oneHot(0), { limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(seeded[1]!);
    expect(result.map((c) => c.id)).not.toContain(seeded[0]!);
  });

  // B4
  it("judges a NULL-posted_at job on created_at — recent-created passes, backdated-created fails", async () => {
    // Both postedAt null. P's created_at defaults to now() → recent; Q is backdated below.
    const seeded = await seedBoard([
      { externalId: "p", title: "Senior Platform Engineer", embedding: oneHot(0) },
      { externalId: "q", title: "Data Platform Engineer", embedding: blend(0.6, 0.8) },
    ]);
    const idP = seeded[0]!;
    const idQ = seeded[1]!;
    // created_at is defaultNow() — only a raw UPDATE can backdate it (30d >> the 14d window).
    await db.execute(sql`UPDATE ${jobs} SET created_at = now() - interval '30 days' WHERE id = ${idQ}`);

    const result = await retrieveCandidatesForProfile(db, oneHot(0), { limit: 10 });
    const ids = result.map((c) => c.id);
    // If COALESCE degrades to bare `posted_at >= ...`, NULL posted_at makes the predicate NULL
    // and P silently disappears.
    expect(ids).toContain(idP);
    // If the recency filter is dropped entirely, the backdated Q reappears — the two seeds pincer
    // both arms of the COALESCE.
    expect(ids).not.toContain(idQ);
  });

  // B5
  it("treats recencyDays as a live parameter — widening to 60 days re-admits the 30-day-old job", async () => {
    const seeded = await seedBoard([
      {
        externalId: "old",
        title: "Senior Platform Engineer",
        postedAt: new Date(Date.now() - 30 * DAY_MS),
        embedding: oneHot(0),
      },
      {
        externalId: "fresh",
        title: "Data Platform Engineer",
        postedAt: new Date(Date.now() - 1 * DAY_MS),
        embedding: blend(0.6, 0.8),
      },
    ]);
    const idOld = seeded[0]!;
    // Sanity anchor: the default 14-day window excludes the 30-day-old job.
    const defaults = await retrieveCandidatesForProfile(db, oneHot(0), { limit: 10 });
    expect(defaults.map((c) => c.id)).not.toContain(idOld);

    const widened = await retrieveCandidatesForProfile(db, oneHot(0), {
      limit: 10,
      recencyDays: 60,
    });
    expect(widened).toHaveLength(2);
    // 14 < 30 < 60: a `${recencyDays}` binding regressed to a literal 14 (or an override swallowed
    // by the opt default) still excludes the job at 60 — only this strict-between seed discriminates.
    expect(widened[0]!.id).toBe(idOld); // nearest → still distance-ordered after re-admission
    expect(widened.map((c) => c.id)).toContain(seeded[1]!);
  });

  // B6
  it("excludes on whole-word, case-insensitive matches — a term hiding inside larger words never excludes", async () => {
    const seeded = await seedBoard([
      // Standalone UPPERCASE word 'AI' in the TITLE ONLY — the explicit description is term-free
      // (toJob's default derives the description FROM the title, which would let a haystack that
      // dropped the title arm still match via the description). Probes the isExcluded wiring, the
      // title arm of the haystack, and the /i flag.
      {
        externalId: "word",
        title: "AI Research Engineer",
        description: "Own the research agenda for large language models",
        embedding: oneHot(0),
      },
      // 'ai' appears ONLY inside email/daily/emails/training — substring-only, must survive.
      {
        externalId: "substr",
        title: "Email Marketing Manager",
        description: "Send daily emails and training updates",
        embedding: blend(0.6, 0.8),
      },
      { externalId: "clean", title: "Platform Engineer", embedding: oneHot(1) },
    ]);
    const result = await retrieveCandidatesForProfile(db, oneHot(0), {
      limit: 10,
      exclusions: ["ai"],
    });
    const ids = result.map((c) => c.id);
    // Dropped isExcluded wiring OR a dropped /i flag both surface the nearest 'AI' job at rank 1.
    expect(ids).not.toContain(seeded[0]!);
    // Dropped `\b` anchors (substring matching) annihilate this row via 'Email'/'daily'/'training'.
    expect(ids).toContain(seeded[1]!);
    expect(ids).toContain(seeded[2]!);
    expect(result[0]!.id).toBe(seeded[1]!); // the substring job is now the nearest survivor
  });

  // B7
  it("scans the DESCRIPTION for exclusion terms, not just the title", async () => {
    const seeded = await seedBoard([
      // D's TITLE is clean — only the description carries the term.
      {
        externalId: "desc-hit",
        title: "Backend Engineer",
        description: "Experience with blockchain infrastructure required",
        embedding: oneHot(0),
      },
      {
        externalId: "clean",
        title: "Frontend Engineer",
        description: "Build accessible web interfaces",
        embedding: blend(0.6, 0.8),
      },
    ]);
    const result = await retrieveCandidatesForProfile(db, oneHot(0), {
      limit: 10,
      exclusions: ["blockchain"],
    });
    expect(result).toHaveLength(1);
    // A haystack degraded to title-only (dropping descriptionText) lets D survive at rank 1.
    expect(result[0]!.id).toBe(seeded[1]!);
  });

  // B8
  it("over-fetches beyond limit so post-filter kills draw on the buffer instead of emptying the result", async () => {
    // The two NEAREST rows fail the exclusion post-filter; the only passing row is FARTHEST.
    const seeded = await seedBoard([
      { externalId: "near-crypto", title: "Crypto Payments Engineer", embedding: oneHot(0) },
      { externalId: "mid-crypto", title: "Senior Crypto Analyst", embedding: blend(0.6, 0.8) },
      { externalId: "clean", title: "Data Engineer", embedding: oneHot(1) },
    ]);
    const result = await retrieveCandidatesForProfile(db, oneHot(0), {
      limit: 1,
      exclusions: ["crypto"],
    });
    // Without `* overFetch` (fetchLimit = limit = 1), SQL returns only the nearest crypto row,
    // the post-filter kills it, and the result is [] — the length assertion goes red.
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(seeded[2]!);
  });

  // B9
  it("trims to exactly `limit` after post-filters, keeping the nearest survivors", async () => {
    // Four passing jobs at strictly distinct distances 0 < 0.4 < 0.72 < 1.0; fetchLimit = 2*3 = 6 > 4,
    // so ALL rows come back from SQL and only the final `.slice(0, limit)` bounds the output.
    const seeded = await seedBoard([
      { externalId: "d0", title: "Senior Platform Engineer", embedding: oneHot(0) },
      { externalId: "d04", title: "Data Platform Engineer", embedding: blend(0.6, 0.8) },
      { externalId: "d072", title: "Staff Data Scientist", embedding: blend(0.28, 0.96) },
      { externalId: "d1", title: "Embedded Firmware Engineer", embedding: oneHot(1) },
    ]);
    const result = await retrieveCandidatesForProfile(db, oneHot(0), { limit: 2 });
    // Removing `.slice(0, limit)` returns all 4 rows.
    expect(result).toHaveLength(2);
    // The "two nearest, in order" half re-pins ordering-before-trim.
    expect(result.map((c) => c.id)).toEqual([seeded[0]!, seeded[1]!]);
  });

  // B10
  it("re-breaks exact distance ties by ascending id — stable order even when physical heap order is reversed", async () => {
    // DIFFERENT titles/descriptions (distinct signatures — must not collapse), IDENTICAL vector
    // → an exact distance tie at 0. idT1 < idT2 by insertion order.
    const seeded = await seedBoard([
      { externalId: "t1", title: "Realtime Systems Engineer", embedding: oneHot(0) },
      { externalId: "t2", title: "Distributed Cache Engineer", embedding: oneHot(0) },
    ]);
    const idT1 = seeded[0]!;
    const idT2 = seeded[1]!;
    // Heap-rewrite trick: UPDATE the LOWER-id row AFTER the higher-id one exists — the new tuple
    // version lands after T2 in seq-scan order, so the tied SQL result comes back [T2, T1] and only
    // the `|| a.id - b.id` tiebreak restores [T1, T2]. Without this rewrite the seed is VACUOUS
    // (heap order == id order and the test passes with the tiebreak deleted). Verified under PGlite:
    // the raw SQL row order after this UPDATE is [T2, T1].
    await db.execute(sql`UPDATE ${jobs} SET updated_at = now() WHERE id = ${idT1}`);

    const result = await retrieveCandidatesForProfile(db, oneHot(0), { limit: 10 });
    expect(result).toHaveLength(2);
    // Removing the id tiebreak leaves JS's stable sort preserving the SQL order → [T2, T1].
    expect(result.map((c) => c.id)).toEqual([idT1, idT2]);
  });

  // B11
  it("never retrieves a lifecycle_state='closed' job, even at distance 0", async () => {
    const seeded = await seedBoard([
      { externalId: "x", title: "Senior Platform Engineer", embedding: oneHot(0) },
      { externalId: "y", title: "Data Platform Engineer", embedding: blend(0.6, 0.8) },
    ]);
    const idX = seeded[0]!;
    // upsertJobs always writes 'active' — closing requires a raw UPDATE (the lifecycle writers'
    // transitions are their own suite's job).
    await db.execute(
      sql`UPDATE ${jobs} SET lifecycle_state = 'closed', closed_at = now() WHERE id = ${idX}`,
    );

    const result = await retrieveCandidatesForProfile(db, oneHot(0), { limit: 10 });
    expect(result).toHaveLength(1);
    // X sits at distance 0 — dropping `lifecycle_state = 'active'` surfaces it at rank 1 (a
    // farther-than-Y closed seed would be vacuous under small limits).
    expect(result[0]!.id).toBe(seeded[1]!);
    expect(result.map((c) => c.id)).not.toContain(idX);
  });

  // B12
  it("never surfaces NULL-embedding rows — a NULL distance would coerce to 0 and rank FIRST app-side", async () => {
    const seeded = await seedBoard([
      // U gets NO writeJobEmbeddings call → embedding stays NULL.
      { externalId: "u", title: "Senior Platform Engineer" },
      { externalId: "v", title: "Data Platform Engineer", embedding: oneHot(0) },
    ]);
    const result = await retrieveCandidatesForProfile(db, oneHot(0), { limit: 10 });
    expect(result).toHaveLength(1);
    // Number(null) === 0: without `embedding IS NOT NULL`, U's NULL `<=>` distance coerces to 0
    // and the app sort promotes it to RANK 1 — not tail-noise, a rank-1 corruption.
    expect(result[0]!.id).toBe(seeded[1]!);
    expect(result.map((c) => c.id)).not.toContain(seeded[0]!);
    // A NULL distance that slipped through would map to a non-finite/zero fake — pin finiteness.
    for (const c of result) expect(Number.isFinite(c.distance)).toBe(true);
  });

  // B13
  it("anti-joins excludeJobIds in SQL — the nearest job disappears when its id is excluded", async () => {
    const seeded = await seedBoard([
      { externalId: "g", title: "Senior Platform Engineer", embedding: oneHot(0) },
      { externalId: "h", title: "Data Platform Engineer", embedding: blend(0.6, 0.8) },
    ]);
    const idG = seeded[0]!;
    const result = await retrieveCandidatesForProfile(db, oneHot(0), {
      limit: 10,
      excludeJobIds: [idG],
    });
    expect(result).toHaveLength(1);
    // G is the nearest neighbour — dropping `id <> ALL($1::int[])` (or the whole branch) returns it
    // at rank 1. Also exercises the intArrayLiteral text-param → ::int[] cast under PGlite.
    expect(result[0]!.id).toBe(seeded[1]!);
    expect(result.map((c) => c.id)).not.toContain(idG);
  });

  // B14
  it("anti-joins excludeSignatures while NULL-signature (un-backfilled) candidates SURVIVE", async () => {
    const seeded = await seedBoard([
      { externalId: "r", title: "Senior Platform Engineer", embedding: oneHot(0) },
      { externalId: "s", title: "Data Platform Engineer", embedding: blend(0.6, 0.8) },
      { externalId: "w", title: "Staff Data Scientist", embedding: blend(0.28, 0.96) },
    ]);
    const idR = seeded[0]!;
    const idS = seeded[1]!;
    const idW = seeded[2]!;
    // Read R's signature BACK from the DB rather than recomputing in JS — keeps the seed honest
    // against signatureSql drift (normalizeSignatureText can diverge on exotic whitespace).
    const sigRows = await db
      .select({ sig: jobs.contentSignature })
      .from(jobs)
      .where(eq(jobs.id, idR));
    expect(sigRows).toHaveLength(1);
    const sigR = sigRows[0]!.sig;
    expect(sigR).toMatch(/^[0-9a-f]{32}$/);
    // upsertJobs ALWAYS writes a signature SQL-side — a NULL (un-backfilled) row needs a raw UPDATE.
    await db.execute(sql`UPDATE ${jobs} SET content_signature = NULL WHERE id = ${idS}`);

    const result = await retrieveCandidatesForProfile(db, oneHot(0), {
      limit: 10,
      excludeSignatures: [sigR!],
    });
    const ids = result.map((c) => c.id);
    // R is nearest — dropping the whole signature condition returns it at rank 1.
    expect(ids).not.toContain(idR);
    // Without the `content_signature IS NULL OR` guard, S's `NULL <> ALL(...)` evaluates NULL and S
    // vanishes — which would silently starve digests of EVERY un-backfilled job.
    expect(ids).toContain(idS);
    expect(ids).toContain(idW);
  });

  // B15
  it("collapses same-signature cross-posts to the lowest-id representative BEFORE the trim, back-filling the freed slot", async () => {
    // X1/X2: different externalIds, byte-identical title+description → identical SQL-computed
    // content_signature, and the SAME vector (identical content ⇒ identical embedding) → tie at 0.
    const seeded = await seedBoard([
      { externalId: "x1", title: "Site Reliability Engineer", embedding: oneHot(0) },
      { externalId: "x2", title: "Site Reliability Engineer", embedding: oneHot(0) },
      { externalId: "y", title: "Data Platform Engineer", embedding: blend(0.6, 0.8) },
    ]);
    const idX1 = seeded[0]!;
    const idX2 = seeded[1]!;
    const idY = seeded[2]!;
    const result = await retrieveCandidatesForProfile(db, oneHot(0), { limit: 2 });
    // limit=2 over exactly 3 candidates makes the back-fill observable: without the collapse (or
    // with collapse-after-trim) the two nearest rows are X1+X2 and Y can never seat.
    expect(result).toHaveLength(2);
    // The representative is min(idX1, idX2) — the id tiebreak (B10) hands collapseBySignature the
    // lower id first, so "first member wins" keeps a stable representative.
    expect(result.map((c) => c.id)).toEqual([Math.min(idX1, idX2), idY]);
    expect(result.map((c) => c.id)).not.toContain(Math.max(idX1, idX2));
  });

  // B16
  it("enforces locationMode through the real path — remote_only drops the nearest on-site job", async () => {
    // Single wiring probe: the geoMatches truth table stays in location-mode.test.ts.
    const seeded = await seedBoard([
      {
        externalId: "onsite",
        title: "Senior Platform Engineer",
        remote: false,
        locations: ["Austin, TX"],
        embedding: oneHot(0),
      },
      {
        externalId: "remote",
        title: "Data Platform Engineer",
        remote: true,
        locations: ["Remote - US"],
        embedding: blend(0.6, 0.8),
      },
    ]);
    const result = await retrieveCandidatesForProfile(db, oneHot(0), {
      limit: 10,
      locationMode: "remote_only",
    });
    expect(result).toHaveLength(1);
    // The on-site job is NEAREST — removing the geoMatches term from the `displayable` filter
    // surfaces it at rank 1.
    expect(result[0]!.id).toBe(seeded[1]!);
    expect(result.map((c) => c.id)).not.toContain(seeded[0]!);
  });

  // B16b — the inverse wiring (absorbs verify-prefs-live PART A's on-site arm): onsite_only must drop the
  // nearest REMOTE job. B16 covers remote_only; the geoMatches truth table stays in location-mode.test.ts.
  it("enforces locationMode onsite_only through the real path — drops the nearest remote job", async () => {
    const seeded = await seedBoard([
      {
        externalId: "remote",
        title: "Senior Platform Engineer",
        remote: true,
        locations: ["Remote - US"],
        embedding: oneHot(0),
      },
      {
        externalId: "onsite",
        title: "Data Platform Engineer",
        remote: false,
        locations: ["Austin, TX"],
        embedding: blend(0.6, 0.8),
      },
    ]);
    const result = await retrieveCandidatesForProfile(db, oneHot(0), {
      limit: 10,
      locationMode: "onsite_only",
    });
    expect(result).toHaveLength(1);
    // The remote job is NEAREST — onsite_only must surface only the on-site row.
    expect(result[0]!.id).toBe(seeded[1]!);
    expect(result.map((c) => c.id)).not.toContain(seeded[0]!);
  });

  // B17
  it("maps raw rows faithfully — jsonb locations array, strict boolean remote, 32-hex signature, finite distance", async () => {
    const seeded = await seedBoard([
      {
        externalId: "map",
        title: "Senior Platform Engineer",
        description: "Own the platform runtime end to end",
        locations: ["Austin, TX", "Remote - US"],
        remote: true,
        embedding: oneHot(0),
      },
    ]);
    const idMap = seeded[0]!;
    const result = await retrieveCandidatesForProfile(db, oneHot(0), { limit: 10 });
    expect(result).toHaveLength(1);
    const candidate = result[0]!;
    expect(candidate.id).toBe(idMap);
    // A jsonb-as-string driver shape would make parseLocations return [] — deep-equal pins the array.
    expect(candidate.locations).toEqual(["Austin, TX", "Remote - US"]);
    // A 't'-string boolean fails the strict `r.remote === true` mapping — toBe is strict equality.
    expect(candidate.remote).toBe(true);
    expect(candidate.descriptionText).toBe("Own the platform runtime end to end");
    // A non-string signature scalar would map to null — the regex pins the 32-hex md5 shape…
    expect(candidate.contentSignature).toMatch(/^[0-9a-f]{32}$/);
    // …and equality with a direct schema read pins it to the ACTUAL stored value, not just any hex.
    const sigRows = await db
      .select({ sig: jobs.contentSignature })
      .from(jobs)
      .where(eq(jobs.id, idMap));
    expect(sigRows).toHaveLength(1);
    expect(candidate.contentSignature).toBe(sigRows[0]!.sig);
    expect(typeof candidate.distance).toBe("number");
    expect(Number.isFinite(candidate.distance)).toBe(true);
    expect(candidate.distance).toBeCloseTo(0, 5);
  });

  // B18
  it("floors overFetch at 1 — an explicit overFetch:0 cannot produce LIMIT 0 and a silently empty result", async () => {
    const seeded = await seedBoard([
      { externalId: "solo", title: "Senior Platform Engineer", embedding: oneHot(0) },
    ]);
    const result = await retrieveCandidatesForProfile(db, oneHot(0), { limit: 1, overFetch: 0 });
    // Without the Math.max(1, ...) floor, fetchLimit = 1*0 = 0 → SQL `LIMIT 0` → [].
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(seeded[0]!);
  });

  // B19
  it("rejects a wrong-width query embedding up front with the 1024-dimension message, before any SQL", async () => {
    // No rows seeded on purpose — the vectorLiteral guard must fire before Postgres is reached.
    // pgvector's own plan-time cast error ("expected 1024 dimensions, not 3") ALSO matches /1024/,
    // so a bare /1024/ matcher would stay green with the guard deleted. Pin the guard's exact text
    // ("vectorLiteral:", "got 3") — only the sql.ts throw can produce it.
    await expect(retrieveCandidatesForProfile(db, new Array<number>(3).fill(0))).rejects.toThrow(
      /vectorLiteral: expected 1024 dimensions, got 3/,
    );
  });
});
