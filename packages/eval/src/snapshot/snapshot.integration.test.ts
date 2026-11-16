import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@opusfinder/db";
import {
  locationRule,
  upsertCompany,
  upsertJobs,
  upsertLocationStrings,
} from "@opusfinder/db/repos";
import { companies, jobs, locationStrings, places } from "@opusfinder/db/schema";
import { companySlug, jobId } from "@opusfinder/shared";

import { createTestDb } from "@test/db/pglite";
import { P, seedPlaces } from "@test/db/places";
import { truncate } from "@test/db/truncate";

import { ATS_SELECTION, exportProductionSlice } from "./export";
import {
  decodeJsonl,
  SnapshotCompanySchema,
  SnapshotLocationStringSchema,
  SnapshotPlaceSchema,
} from "./format";
import { SYNTHETIC_ID_BASE } from "./format";
import { serializeManifest } from "./manifest";
import type { PublicLocation, PublicPosting } from "./public-jobs";
import { buildPublicSlice, FEED_RESOLVER_VERSION } from "./public-slice";
import { buildManifest } from "./publish";
import { loadSnapshotIntoDb, openSnapshot } from "./read";
import { listObjects, readJobsPart, readObject, snapshotPaths } from "./store";

describe("buildPublicSlice (integration: real PGlite)", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;
  const FETCHED_AT = "2026-11-16T03:42:11.792Z";

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedPlaces(db);
  });
  afterAll(async () => {
    await truncate(db, companies, jobs, places);
    await close?.();
  });

  const ohio = (city: string, coordinates?: { lat: number; lng: number }): PublicLocation => ({
    raw: `${city}, Ohio`,
    ...(coordinates ? { coordinates } : {}),
    answer: {
      reason: "USAJOBS structured city and state.",
      places: [{ city, region: "Ohio", country: "US", kind: "city" }],
      remoteCountries: [],
      areas: [],
      confidence: "high",
    },
  });
  const posting = (
    externalId: string,
    employer: string,
    locations: PublicLocation[],
  ): PublicPosting => ({
    source: "usajobs",
    externalId,
    employer,
    title: `Role ${externalId}`,
    descriptionText: `What role ${externalId} does. `.repeat(12),
    locations,
    remote: false,
    applyUrl: `https://www.usajobs.gov/job/${externalId}`,
    postedAt: new Date("2026-11-01T00:00:00Z"),
  });

  it("writes postings through production's job writer and places them with production's check", async () => {
    const slice = await buildPublicSlice(
      db,
      [
        posting("300", "Veterans Health Administration", [ohio("Columbus")]),
        // Not a gazetteer city, but the feed puts it two miles from Columbus.
        posting("100", "Air Force Materiel Command", [
          ohio("Defense Supply Center", { lat: 39.99, lng: -83.0 }),
        ]),
        // Not a gazetteer city, and nowhere near one.
        posting("200", "Air Force Materiel Command", [
          ohio("Remote Radar Site", { lat: 45, lng: -100 }),
        ]),
        {
          ...posting("400", "Veterans Health Administration", [
            { raw: "Somewhere, Atlantis", answer: null },
          ]),
        },
      ],
      FETCHED_AT,
    );

    // Synthetic ids, in employer-then-posting order whatever order the feed gave.
    expect(slice.companies).toEqual([
      {
        id: SYNTHETIC_ID_BASE + 1,
        slug: "air-force-materiel-command",
        source: "usajobs",
        name: "Air Force Materiel Command",
      },
      {
        id: SYNTHETIC_ID_BASE + 2,
        slug: "veterans-health-administration",
        source: "usajobs",
        name: "Veterans Health Administration",
      },
    ]);
    expect(slice.jobs.map((j) => [j.id, j.externalId, j.companyId])).toEqual([
      [SYNTHETIC_ID_BASE + 1, "100", SYNTHETIC_ID_BASE + 1],
      [SYNTHETIC_ID_BASE + 2, "200", SYNTHETIC_ID_BASE + 1],
      [SYNTHETIC_ID_BASE + 3, "300", SYNTHETIC_ID_BASE + 2],
      [SYNTHETIC_ID_BASE + 4, "400", SYNTHETIC_ID_BASE + 2],
    ]);
    expect(slice.jobs[0]).toMatchObject({
      slice: "public",
      source: "usajobs",
      createdAt: FETCHED_AT,
      lastSeenAt: FETCHED_AT,
      postedAt: "2026-11-01T00:00:00.000Z",
      productionEmbeddingModel: null,
      flags: [],
    });
    // The signature is production's (written by upsertJobs).
    expect(slice.jobs[0]?.contentSignature).toMatch(/^[0-9a-f]{32}$/);

    const byRaw = new Map(slice.locationStrings.map((s) => [s.raw, s]));
    expect(byRaw.get("Columbus, Ohio")).toMatchObject({
      placeIds: [P.COLUMBUS_OH],
      confidence: "high",
      promptVersion: FEED_RESOLVER_VERSION,
    });
    expect(byRaw.get("Defense Supply Center, Ohio")).toMatchObject({
      placeIds: [P.COLUMBUS_OH],
      unmatched: [],
      confidence: "medium",
      reason: expect.stringMatching(/nearest city to the feed's coordinates \(2\.\d mi\)/),
    });
    expect(byRaw.get("Remote Radar Site, Ohio")).toMatchObject({
      placeIds: [],
      unmatched: [expect.objectContaining({ why: "unknown-city" })],
      confidence: "high",
    });
    expect(byRaw.get("Somewhere, Atlantis")).toMatchObject({ placeIds: [], confidence: null });
    expect(slice.locations).toEqual({
      placed: 1,
      placedByCoordinates: 1,
      remoteOnly: 0,
      unmatched: 1,
      unanswered: 1,
    });
  });
});

// The export against a real Postgres (PGlite) carrying the production schema: what it selects, that
// it reads inside a read-only transaction, that every row it writes passes the snapshot's schema, and
// that what it writes is enough to run production's location rule on the frozen jobs.

const ID = "2026-11-16";

describe("snapshot export and load (integration: real PGlite)", () => {
  let db: Db;
  let client: PGlite;
  let close: (() => Promise<void>) | undefined;
  let root: string;
  let dir: string;

  beforeAll(async () => {
    ({ db, client, close } = await createTestDb());
    root = mkdtempSync(join(tmpdir(), "snapshot-export-"));
    dir = snapshotPaths(ID, root).objects;
    await seedPlaces(db);
    const acme = await upsertCompany(db, companySlug("acme"), "greenhouse");
    const idle = await upsertCompany(db, companySlug("idle"), "lever");
    const posting = (
      key: string,
      extra: { title?: string; descriptionText?: string; locations?: string[] } = {},
    ) => ({
      source: "greenhouse" as const,
      externalId: jobId(key),
      title: extra.title ?? `Role ${key}`,
      companySlug: companySlug("acme"),
      locations: extra.locations ?? ["Columbus, OH"],
      remote: false,
      descriptionText: extra.descriptionText ?? `A full description for ${key}. `.repeat(12),
      applyUrl: `https://example.test/${key}`,
      postedAt: new Date("2026-11-01T00:00:00Z"),
    });
    await upsertJobs(db, acme, [
      posting("open"),
      posting("junk", { title: "d", descriptionText: "" }),
      posting("far", { locations: ["Dallas, TX"] }),
    ]);
    await upsertJobs(db, idle, [
      { ...posting("closed"), source: "lever", companySlug: companySlug("idle") },
    ]);
    await db
      .update(jobs)
      .set({ lifecycleState: "closed" })
      .where(eq(jobs.externalId, jobId("closed")));
    const resolved = (raw: string, placeId: number) => ({
      companyId: acme,
      raw,
      placeIds: [placeId],
      remoteCountries: [],
      unmatched: [],
      confidence: "high" as const,
      reason: "fixture",
      promptVersion: "test",
    });
    await upsertLocationStrings(db, [
      resolved("Columbus, OH", P.COLUMBUS_OH),
      resolved("Dallas, TX", P.DALLAS_TX),
    ]);
  });
  afterAll(async () => {
    await truncate(db, companies, jobs, locationStrings, places);
    await close?.();
    rmSync(root, { recursive: true, force: true });
  });

  it("writes the active jobs, their companies, the location strings and the places", async () => {
    const result = await exportProductionSlice(client, () => dir);

    expect(result.jobs).toBe(3);
    expect(result.bySource).toEqual({ greenhouse: 3 });
    expect(result.byFlag).toEqual({
      blank_description: 1,
      short_description: 0,
      short_title: 1,
      capped: 0,
    });
    expect(Number.isNaN(Date.parse(result.takenAt))).toBe(false);

    const exported = readJobsPart(dir, "jobs/ats-0000.jsonl.gz");
    expect(exported.map((j) => j.externalId)).toEqual(["open", "junk", "far"]);
    expect(exported[0]).toMatchObject({
      slice: "ats",
      source: "greenhouse",
      title: "Role open",
      locations: ["Columbus, OH"],
      remote: false,
      postedAt: "2026-11-01T00:00:00.000Z",
      productionEmbeddingModel: null,
      flags: [],
    });
    expect(exported[0]?.contentSignature).toMatch(/^[0-9a-f]{32}$/);
    // The junk posting is kept and flagged, never dropped.
    expect(exported[1]).toMatchObject({ title: "d", flags: ["blank_description", "short_title"] });

    // Only companies with an active job; every location string and place.
    const table = <T>(path: string, schema: Parameters<typeof decodeJsonl<T>>[1]) =>
      decodeJsonl(readObject(dir, path), schema, path);
    expect(table("companies/part-0000.jsonl.gz", SnapshotCompanySchema)).toEqual([
      { id: exported[0]?.companyId, slug: "acme", source: "greenhouse", name: null },
    ]);
    expect(table("location-strings/part-0000.jsonl.gz", SnapshotLocationStringSchema)).toEqual([
      expect.objectContaining({
        raw: "Columbus, OH",
        placeIds: [P.COLUMBUS_OH],
        confidence: "high",
      }),
      expect.objectContaining({ raw: "Dallas, TX", placeIds: [P.DALLAS_TX] }),
    ]);
    const exportedPlaces = table("places/part-0000.jsonl.gz", SnapshotPlaceSchema);
    expect(exportedPlaces.length).toBe(result.tables.places);
    expect(exportedPlaces.find((p) => p.geonamesId === P.COLUMBUS_OH)).toMatchObject({
      kind: "city",
      countryCode: "US",
      lat: expect.any(Number),
    });
    expect(listObjects(dir)).toEqual([
      "companies/part-0000.jsonl.gz",
      "jobs/ats-0000.jsonl.gz",
      "location-strings/part-0000.jsonl.gz",
      "places/part-0000.jsonl.gz",
    ]);
  });

  it("reads inside a read-only transaction and leaves none open", async () => {
    const statements: string[] = [];
    await exportProductionSlice(
      {
        query: (text, params) => {
          statements.push(text.trim().split(/\s+/).slice(0, 2).join(" "));
          return client.query(text, params);
        },
      },
      () => dir,
    );
    expect(statements[0]).toBe("BEGIN TRANSACTION");
    expect(statements.at(-1)).toBe("COMMIT");
    // A write is possible again, so the transaction really ended.
    await expect(db.update(jobs).set({ remote: false })).resolves.toBeDefined();
  });

  it("refuses to run when the session is not read-only", async () => {
    const lying = {
      query: (text: string, params?: unknown[]) =>
        text.startsWith("BEGIN") ? client.query("BEGIN") : client.query(text, params),
    };
    await expect(exportProductionSlice(lying, () => dir)).rejects.toThrow(/not read-only/);
    // And it rolled back, so the session is usable.
    await expect(client.query("SELECT 1")).resolves.toBeDefined();
  });

  it("loads into an empty database, where production's location rule runs on the frozen jobs", async () => {
    const { takenAt } = await exportProductionSlice(client, () => dir);
    const paths = snapshotPaths(ID, root);
    const manifest = await buildManifest({
      id: ID,
      objectsDir: paths.objects,
      workDir: paths.work,
      sliceRecords: { ats: { selection: ATS_SELECTION, takenAt } },
    });
    writeFileSync(paths.manifest, serializeManifest(manifest));
    const before = await db.select({ id: jobs.id, externalId: jobs.externalId }).from(jobs);

    await truncate(db, companies, jobs, locationStrings, places);
    const snapshot = openSnapshot(ID, root);
    await loadSnapshotIntoDb(db, snapshot);

    // Every active job is back under its own id.
    const loaded = await db.select({ id: jobs.id, externalId: jobs.externalId }).from(jobs);
    const key = (r: { id: number }) => r.id;
    expect(loaded.sort((a, b) => key(a) - key(b))).toEqual(
      before.filter((r) => r.externalId !== "closed").sort((a, b) => key(a) - key(b)),
    );

    // A user 50 miles around Columbus gets the Columbus jobs and not the Dallas one.
    const active = sql`j.lifecycle_state = 'active'`;
    const rule = locationRule(
      { mode: "any", home: { placeId: P.COLUMBUS_OH, radiusMiles: 50 } },
      active,
    );
    const local = (await db.execute(
      sql`WITH ${rule.ctes} SELECT j.external_id FROM ${jobs} j ${rule.join}
          WHERE ${active} AND ${rule.passes} ORDER BY j.id`,
    )) as unknown as { rows: { external_id: string }[] };
    expect(local.rows.map((r) => r.external_id)).toEqual(["open", "junk"]);
  });
});
