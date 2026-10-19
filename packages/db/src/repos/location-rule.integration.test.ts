import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  countLocalStrings,
  explainJob,
  retrieveCandidatesForProfile,
  upsertCompany,
  upsertJobs,
  upsertLocationStrings,
  writeJobEmbeddings,
  type LocationFilter,
} from "@opusfinder/db/repos";
import { companies, jobs, locationStrings, places } from "@opusfinder/db/schema";
import { companySlug, jobId, type LocationMode } from "@opusfinder/shared";

import { P, seedPlaces } from "@test/db/places";
import { truncate } from "@test/db/truncate";
import { createTestDb } from "@test/db/pglite";
import { blend, oneHot } from "@test/db/vectors";

/** A job: its company, raw location strings, remote flag, and (unless stated) a vector at distance 0. */
interface JobSpec {
  key: string;
  company?: string;
  locations: string[];
  remote?: boolean;
  embedding?: number[];
}

/** What a (company, raw) string resolved to. */
interface StringSpec {
  company?: string;
  raw: string;
  placeIds?: number[];
  remoteCountries?: string[];
  /** The model gave no usable answer (confidence NULL). */
  unanswered?: boolean;
  /** A place the model named that failed the GeoNames check. */
  unmatchedCountry?: string;
}

const COLUMBUS_50: LocationFilter["home"] = { placeId: P.COLUMBUS_OH, radiusMiles: 50 };

describe("location rule in retrieval (integration: real PGlite)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedPlaces(db);
  });
  beforeEach(async () => {
    await truncate(db, companies, jobs, locationStrings);
  });
  afterAll(async () => {
    await truncate(db, places);
    await close?.();
  });

  async function companyId(slug: string): Promise<number> {
    return upsertCompany(db, companySlug(slug), "greenhouse");
  }

  /** Seed jobs (by company) and the resolved strings; returns job ids by key. */
  async function seed(specs: JobSpec[], strings: StringSpec[]): Promise<Map<string, number>> {
    const ids = new Map<string, number>();
    const byCompany = new Map<string, JobSpec[]>();
    for (const s of specs)
      byCompany.set(s.company ?? "acme", [...(byCompany.get(s.company ?? "acme") ?? []), s]);
    for (const [slug, list] of byCompany) {
      const cid = await companyId(slug);
      await upsertJobs(
        db,
        cid,
        list.map((s) => ({
          source: "greenhouse" as const,
          externalId: jobId(s.key),
          title: `Role ${s.key}`,
          companySlug: companySlug(slug),
          locations: s.locations,
          remote: s.remote ?? false,
          descriptionText: `Description for ${s.key}`,
          applyUrl: `https://example.test/${s.key}`,
          postedAt: null,
        })),
      );
    }
    const rows = await db.select({ id: jobs.id, externalId: jobs.externalId }).from(jobs);
    for (const r of rows) ids.set(r.externalId as string, r.id);
    await writeJobEmbeddings(
      db,
      specs.map((s) => ({ id: ids.get(s.key)!, embedding: s.embedding ?? oneHot(0) })),
    );
    const rowsToStore = [];
    for (const s of strings) {
      rowsToStore.push({
        companyId: await companyId(s.company ?? "acme"),
        raw: s.raw,
        placeIds: s.placeIds ?? [],
        remoteCountries: s.remoteCountries ?? [],
        unmatched: s.unmatchedCountry
          ? [
              {
                city: null,
                region: null,
                country: s.unmatchedCountry,
                kind: "country" as const,
                why: "unknown-country" as const,
              },
            ]
          : [],
        confidence: s.unanswered ? null : ("high" as const),
        reason: "fixture",
        promptVersion: "test",
      });
    }
    await upsertLocationStrings(db, rowsToStore);
    return ids;
  }

  async function retrievedKeys(
    ids: Map<string, number>,
    location: LocationFilter,
    limit = 50,
  ): Promise<string[]> {
    const byId = new Map([...ids].map(([k, v]) => [v, k]));
    const result = await retrieveCandidatesForProfile(db, oneHot(0), { limit, location });
    return result.map((c) => byId.get(c.id)!).sort();
  }

  describe("no home place: location mode only", () => {
    const specs: JobSpec[] = [
      { key: "remote", locations: ["Remote"], remote: true },
      { key: "onsite", locations: ["Westerville, OH"] },
      { key: "unresolved", locations: ["Somewhere Unknown"] },
    ];
    const strings: StringSpec[] = [
      { raw: "Westerville, OH", placeIds: [P.WESTERVILLE_OH] },
      { raw: "Remote" },
    ];

    it.each<[LocationMode, string[]]>([
      ["any", ["onsite", "remote", "unresolved"]],
      ["remote_only", ["remote"]],
      ["onsite_only", ["onsite", "unresolved"]],
    ])("mode %s keeps %j", async (mode, expected) => {
      const ids = await seed(specs, strings);
      expect(await retrievedKeys(ids, { mode, home: null })).toEqual(expected);
    });
  });

  describe("home Columbus, OH within 50 miles, mode any", () => {
    it("keeps exactly the local on-site jobs and the remote jobs open to the US", async () => {
      const ids = await seed(
        [
          { key: "suburb", locations: ["Westerville, OH"] },
          { key: "inside-49.5", locations: ["Insideville"] },
          { key: "outside-50.5", locations: ["Outsideville"] },
          { key: "region-only", locations: ["Ohio, United States"] },
          { key: "region-and-far-city", locations: ["Cincinnati, OH", "Ohio"] },
          { key: "other-region", locations: ["Texas"] },
          { key: "country-only", locations: ["United States"] },
          { key: "unresolved", locations: ["Not Resolved Yet"] },
          { key: "hybrid", locations: ["Hybrid"] },
          { key: "multi-place-one-local", locations: ["Dallas, TX | Columbus, OH"] },
          { key: "remote-plain", locations: ["Remote"], remote: true },
          { key: "remote-us", locations: ["Remote - USA"], remote: true },
          { key: "remote-turkiye", locations: ["Remote, Türkiye"], remote: true },
          { key: "remote-london", locations: ["London, UK", "Remote"], remote: true },
          { key: "remote-unresolved", locations: ["Not Resolved Remote"], remote: true },
          {
            key: "remote-plus-unresolved",
            locations: ["Remote", "Not Resolved Remote"],
            remote: true,
          },
          { key: "remote-unanswered", locations: ["Refused Remote"], remote: true },
          { key: "remote-unchecked-country", locations: ["Remote, Deutschland"], remote: true },
          {
            key: "remote-us-plus-unresolved",
            locations: ["Remote - USA", "Not Resolved Remote"],
            remote: true,
          },
          { key: "region-plus-unresolved", locations: ["Ohio", "Not Resolved Yet"] },
          { key: "no-strings-remote", locations: [], remote: true },
        ],
        [
          { raw: "Westerville, OH", placeIds: [P.WESTERVILLE_OH] },
          { raw: "Insideville", placeIds: [P.INSIDE_50] },
          { raw: "Outsideville", placeIds: [P.OUTSIDE_50] },
          { raw: "Ohio, United States", placeIds: [P.OHIO] },
          { raw: "Cincinnati, OH", placeIds: [P.CINCINNATI_OH] },
          { raw: "Ohio", placeIds: [P.OHIO] },
          { raw: "Texas", placeIds: [P.TEXAS] },
          { raw: "United States", placeIds: [P.US] },
          { raw: "Hybrid" },
          { raw: "Dallas, TX | Columbus, OH", placeIds: [P.DALLAS_TX, P.COLUMBUS_OH] },
          { raw: "Remote" },
          { raw: "Remote - USA", remoteCountries: ["US"] },
          { raw: "Remote, Türkiye", remoteCountries: ["TR"] },
          { raw: "London, UK", placeIds: [P.LONDON_GB] },
          { raw: "Refused Remote", unanswered: true },
          { raw: "Remote, Deutschland", unmatchedCountry: "DEU" },
        ],
      );
      // A pass that rests on something being absent (no country named; the region and no city in it) needs
      // every string resolved; a presence-based pass (near city, the user's country) doesn't.
      expect(await retrievedKeys(ids, { mode: "any", home: COLUMBUS_50 })).toEqual(
        [
          "suburb",
          "inside-49.5",
          "region-only",
          "multi-place-one-local",
          "remote-plain",
          "remote-us",
          "remote-us-plus-unresolved",
          "no-strings-remote",
        ].sort(),
      );
    });

    it("onsite_only drops every remote job; remote_only drops every on-site job", async () => {
      const ids = await seed(
        [
          { key: "suburb", locations: ["Westerville, OH"] },
          { key: "remote-us", locations: ["Remote - USA"], remote: true },
        ],
        [
          { raw: "Westerville, OH", placeIds: [P.WESTERVILLE_OH] },
          { raw: "Remote - USA", remoteCountries: ["US"] },
        ],
      );
      expect(await retrievedKeys(ids, { mode: "onsite_only", home: COLUMBUS_50 })).toEqual([
        "suburb",
      ]);
      expect(await retrievedKeys(ids, { mode: "remote_only", home: COLUMBUS_50 })).toEqual([
        "remote-us",
      ]);
    });

    it("honors a smaller radius", async () => {
      const ids = await seed(
        [
          { key: "suburb-12mi", locations: ["Westerville, OH"] },
          { key: "london-oh-25mi", locations: ["London, OH"] },
        ],
        [
          { raw: "Westerville, OH", placeIds: [P.WESTERVILLE_OH] },
          { raw: "London, OH", placeIds: [P.LONDON_OH] },
        ],
      );
      const home = { placeId: P.COLUMBUS_OH, radiusMiles: 20 };
      expect(await retrievedKeys(ids, { mode: "any", home })).toEqual(["suburb-12mi"]);
    });
  });

  describe("the most specific place wins", () => {
    const specs: JobSpec[] = [
      { key: "dallas-and-texas", locations: ["Dallas, TX", "Texas"] },
      { key: "texas-only", locations: ["Texas"] },
    ];
    const strings: StringSpec[] = [
      { raw: "Dallas, TX", placeIds: [P.DALLAS_TX] },
      { raw: "Texas", placeIds: [P.TEXAS] },
    ];

    it("a job listed as Dallas and Texas is a Dallas job: not local to Houston, local to Dallas", async () => {
      const ids = await seed(specs, strings);
      expect(
        await retrievedKeys(ids, { mode: "any", home: { placeId: P.HOUSTON_TX, radiusMiles: 50 } }),
      ).toEqual(["texas-only"]);
      expect(
        await retrievedKeys(ids, { mode: "any", home: { placeId: P.DALLAS_TX, radiusMiles: 50 } }),
      ).toEqual(["dallas-and-texas", "texas-only"]);
    });
  });

  it("reads a string by its company: the same bare text can mean different places", async () => {
    const ids = await seed(
      [
        { key: "ohio-co-dublin", company: "buckeye", locations: ["Dublin"] },
        { key: "irish-co-dublin", company: "emerald", locations: ["Dublin"] },
      ],
      [
        { company: "buckeye", raw: "Dublin", placeIds: [P.DUBLIN_OH] },
        { company: "emerald", raw: "Dublin", placeIds: [P.DUBLIN_IE] },
      ],
    );
    expect(await retrievedKeys(ids, { mode: "any", home: COLUMBUS_50 })).toEqual([
      "ohio-co-dublin",
    ]);
  });

  it("filters before the cosine limit: 10 local jobs come back past 200 closer jobs elsewhere", async () => {
    // The old app-side filter ran on the cosine top-150 and returned none of these 10.
    const far = Array.from({ length: 200 }, (_, i) => ({
      key: `far-${i}`,
      locations: ["Dallas, TX"],
      embedding: oneHot(0),
    }));
    const near = Array.from({ length: 10 }, (_, i) => ({
      key: `near-${i}`,
      locations: ["Westerville, OH"],
      embedding: blend(0.6, 0.8),
    }));
    const ids = await seed(
      [...far, ...near],
      [
        { raw: "Dallas, TX", placeIds: [P.DALLAS_TX] },
        { raw: "Westerville, OH", placeIds: [P.WESTERVILLE_OH] },
      ],
    );
    expect(await retrievedKeys(ids, { mode: "any", home: COLUMBUS_50 }, 10)).toEqual(
      near.map((n) => n.key).sort(),
    );
  });

  it("stays an exact scan with the rule active when the planner is pushed toward the HNSW index", async () => {
    const ids = await seed(
      Array.from({ length: 40 }, (_, i) => {
        const angle = (i * Math.PI) / 80;
        return {
          key: `j${i}`,
          // The 30 nearest are in Dallas, so a plan on the index (~ef_search rows, then the filter) finds none
          // of the 10 local ones.
          locations: [i < 30 ? "Dallas, TX" : "Westerville, OH"],
          embedding: blend(Math.cos(angle), Math.sin(angle)),
        };
      }),
      [
        { raw: "Dallas, TX", placeIds: [P.DALLAS_TX] },
        { raw: "Westerville, OH", placeIds: [P.WESTERVILLE_OH] },
      ],
    );
    await db.execute(sql`SET enable_seqscan = off`);
    await db.execute(sql`SET hnsw.ef_search = 1`);
    try {
      const result = await retrieveCandidatesForProfile(db, oneHot(0), {
        limit: 10,
        overFetch: 1,
        location: { mode: "any", home: COLUMBUS_50 },
      });
      expect(result.map((c) => c.id)).toEqual(
        Array.from({ length: 10 }, (_, i) => ids.get(`j${30 + i}`)!),
      );
    } finally {
      await db.execute(sql`RESET enable_seqscan`);
      await db.execute(sql`RESET hnsw.ef_search`);
    }
  });

  it("counts the strings local to a home: a city within the radius or the home region", async () => {
    await seed(
      [
        {
          key: "a",
          locations: ["Westerville, OH", "Ohio", "Cincinnati, OH", "Texas", "Remote - USA"],
        },
      ],
      [
        { raw: "Westerville, OH", placeIds: [P.WESTERVILLE_OH] },
        { raw: "Ohio", placeIds: [P.OHIO] },
        { raw: "Cincinnati, OH", placeIds: [P.CINCINNATI_OH] },
        { raw: "Texas", placeIds: [P.TEXAS] },
        { raw: "Remote - USA", remoteCountries: ["US"] },
        // Local, but listed by no active job: not counted.
        { raw: "Dublin, OH", placeIds: [P.DUBLIN_OH] },
      ],
    );
    expect(await countLocalStrings(db, COLUMBUS_50!)).toBe(2);
  });

  it("explains a job with the rule's own verdict and each place's distance", async () => {
    const ids = await seed(
      [{ key: "far-in-region", locations: ["Cincinnati, OH", "Ohio", "Not Resolved Yet"] }],
      [
        { raw: "Cincinnati, OH", placeIds: [P.CINCINNATI_OH] },
        { raw: "Ohio", placeIds: [P.OHIO] },
      ],
    );
    const job = await explainJob(db, ids.get("far-in-region")!, { mode: "any", home: COLUMBUS_50 });

    expect(job).not.toBeNull();
    expect(job!.passes).toBe(false);
    expect(job!.verdict).toBe("on-site job naming a city in your region beyond 50 mi");
    const cincinnati = job!.strings.find((s) => s.raw === "Cincinnati, OH")!;
    expect(cincinnati.places[0]).toMatchObject({ name: "Cincinnati", kind: "city" });
    expect(cincinnati.places[0]!.miles).toBeGreaterThan(95);
    expect(cincinnati.places[0]!.miles).toBeLessThan(110);
    expect(job!.strings.find((s) => s.raw === "Ohio")!.places[0]).toMatchObject({
      kind: "region",
      miles: null,
    });
    expect(job!.strings.find((s) => s.raw === "Not Resolved Yet")!.stored).toBe(false);
  });
});
