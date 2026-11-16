/**
 * Turning the fetched public-sector postings into the snapshot's `public` slice, through production's
 * own code in a local database: `upsertJobs` writes them (so text limits, location order and the
 * content signature are production's), and the GeoNames check places each location from the feed's
 * structured fields against the snapshot's own places. Nothing here touches production.
 */
import { eq, sql } from "drizzle-orm";

import type { Db } from "@opusfinder/db";
import { milesBetween, upsertCompany, upsertJobs } from "@opusfinder/db/repos";
import { companies, jobs, places } from "@opusfinder/db/schema";
import { checkAnswers, loadGazetteer, type LocationAnswerValue } from "@opusfinder/locations";
import {
  companySlug,
  jobId,
  type LocationConfidence,
  type NormalizedJob,
  type SourceName,
} from "@opusfinder/shared";

import {
  jobFlags,
  SnapshotCompanySchema,
  SnapshotJobSchema,
  SnapshotLocationStringSchema,
  SYNTHETIC_ID_BASE,
  type SnapshotCompany,
  type SnapshotJob,
  type SnapshotLocationString,
} from "./format";
import type { PublicLocation, PublicPosting } from "./public-jobs";

/** Stored as the location strings' prompt version: no prompt read them, the feed's fields did. */
export const FEED_RESOLVER_VERSION = "feed-structured-1";
const UPSERT_BATCH = 250;
/** How far the feed's point may be from the city that stands in for an unnamed place. Well inside
 *  the default 50-mile radius a user's location filter uses. */
const NEAREST_CITY_MILES = 15;

export interface PublicSlice {
  jobs: SnapshotJob[];
  companies: SnapshotCompany[];
  locationStrings: SnapshotLocationString[];
  /** Location strings by outcome: placed by name, placed at the nearest city to the feed's point,
   *  remote-only, naming a place neither found, and without a usable answer. */
  locations: {
    placed: number;
    placedByCoordinates: number;
    remoteOnly: number;
    unmatched: number;
    unanswered: number;
  };
}

interface NearestCity {
  geonamesId: number;
  miles: number;
}

/** The gazetteer city of `countryCode` nearest to a point, if one lies within NEAREST_CITY_MILES. */
async function nearestCity(
  db: Db,
  countryCode: string,
  point: { lat: number; lng: number },
): Promise<NearestCity | null> {
  // A box a little wider than the limit keeps the distance maths off most of the table.
  const latSpan = (NEAREST_CITY_MILES * 1.2) / 69;
  const lngSpan = latSpan / Math.max(0.2, Math.cos((point.lat * Math.PI) / 180));
  const miles = milesBetween(
    sql`${point.lat}::float8`,
    sql`${point.lng}::float8`,
    sql`p.lat`,
    sql`p.lng`,
  );
  const result = (await db.execute(sql`
    SELECT p.geonames_id, ${miles} AS miles FROM ${places} p
    WHERE p.kind = 'city' AND p.country_code = ${countryCode}
      AND p.lat BETWEEN ${point.lat - latSpan} AND ${point.lat + latSpan}
      AND p.lng BETWEEN ${point.lng - lngSpan} AND ${point.lng + lngSpan}
    ORDER BY miles, p.population DESC NULLS LAST, p.geonames_id
    LIMIT 1
  `)) as unknown as { rows: { geonames_id: number; miles: number }[] };
  const row = result.rows[0];
  return row && Number(row.miles) <= NEAREST_CITY_MILES
    ? { geonamesId: row.geonames_id, miles: Number(row.miles) }
    : null;
}

const slugify = (name: string): string =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";

/**
 * Build the slice in `db`: a database with production's schema that already holds the snapshot's
 * places and no jobs or companies. `fetchedAt` is when the feeds were read: it becomes every job's
 * first-seen and last-seen time.
 */
export async function buildPublicSlice(
  db: Db,
  postings: PublicPosting[],
  fetchedAt: string,
): Promise<PublicSlice> {
  // Ids that can never collide with production's.
  await db.execute(
    sql.raw(`ALTER SEQUENCE companies_id_seq RESTART WITH ${SYNTHETIC_ID_BASE + 1}`),
  );
  await db.execute(sql.raw(`ALTER SEQUENCE jobs_id_seq RESTART WITH ${SYNTHETIC_ID_BASE + 1}`));

  // One company per (feed, employer), in a stable order so ids don't depend on fetch order.
  const sorted = [...postings].sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.employer.localeCompare(b.employer) ||
      a.externalId.localeCompare(b.externalId, "en", { numeric: true }),
  );
  const byEmployer = new Map<string, PublicPosting[]>();
  for (const p of sorted) {
    const key = JSON.stringify([p.source, p.employer]);
    byEmployer.set(key, [...(byEmployer.get(key) ?? []), p]);
  }

  const pairs = new Map<string, PublicLocation & { companyId: number }>();
  for (const list of byEmployer.values()) {
    const { source, employer } = list[0] as PublicPosting;
    const slug = companySlug(slugify(employer));
    const companyId = await upsertCompany(db, slug, source as SourceName);
    await db
      .update(companies)
      .set({ metadata: { name: employer } })
      .where(eq(companies.id, companyId));
    for (let i = 0; i < list.length; i += UPSERT_BATCH) {
      await upsertJobs(
        db,
        companyId,
        list.slice(i, i + UPSERT_BATCH).map(
          (p): NormalizedJob => ({
            source: p.source as SourceName,
            externalId: jobId(p.externalId),
            title: p.title,
            companySlug: slug,
            locations: p.locations.map((l) => l.raw),
            remote: p.remote,
            descriptionText: p.descriptionText,
            applyUrl: p.applyUrl,
            postedAt: p.postedAt,
          }),
        ),
      );
    }
    for (const p of list) {
      for (const l of p.locations) {
        pairs.set(JSON.stringify([companyId, l.raw]), { ...l, companyId });
      }
    }
  }

  // The production check, fed the feeds' structured fields in place of a model's reading.
  const answered = [...pairs.values()].filter((p) => p.answer !== null);
  const checked = await checkAnswers(
    db,
    await loadGazetteer(db),
    answered.map((p) => p.answer as LocationAnswerValue),
  );
  const resultOf = new Map(answered.map((pair, i) => [pair, checked[i]]));
  const counts = { placed: 0, placedByCoordinates: 0, remoteOnly: 0, unmatched: 0, unanswered: 0 };
  const nearest = new Map<string, Promise<NearestCity | null>>();
  const locationStrings: SnapshotLocationString[] = [];
  for (const pair of pairs.values()) {
    const result = resultOf.get(pair);
    let placeIds = result?.placeIds ?? [];
    let unmatched = result?.unmatched ?? [];
    let confidence: LocationConfidence | null = result ? "high" : null;
    let reason =
      pair.answer?.reason ??
      "The feed's structured fields name no place the gazetteer has a country for.";

    if (!result) counts.unanswered++;
    else if (placeIds.length > 0) counts.placed++;
    else if (result.remoteCountries.length > 0) counts.remoteOnly++;
    else {
      // The name isn't a gazetteer city (a military base, a county). The feed says where it is, so
      // the nearest city to that point stands in, if one is close.
      const country = pair.answer?.places[0]?.country;
      const point = pair.coordinates;
      const key = JSON.stringify([country, point]);
      if (country && point && !nearest.has(key)) nearest.set(key, nearestCity(db, country, point));
      const city = (await nearest.get(key)) ?? null;
      if (city) {
        counts.placedByCoordinates++;
        placeIds = [city.geonamesId];
        unmatched = [];
        confidence = "medium";
        reason = `Not a gazetteer city by name; placed at the nearest city to the feed's coordinates (${city.miles.toFixed(1)} mi).`;
      } else counts.unmatched++;
    }
    locationStrings.push(
      SnapshotLocationStringSchema.parse({
        companyId: pair.companyId,
        raw: pair.raw,
        placeIds,
        remoteCountries: result?.remoteCountries ?? [],
        unmatched,
        confidence,
        reason,
        promptVersion: FEED_RESOLVER_VERSION,
      }),
    );
  }

  const stored = await db.select().from(jobs).orderBy(jobs.id);
  const snapshotJobs = stored.map((r) => {
    const text = { title: r.title, descriptionText: r.descriptionText };
    return SnapshotJobSchema.parse({
      id: r.id,
      slice: "public",
      source: r.source,
      externalId: r.externalId,
      companyId: r.companyId,
      ...text,
      locations: r.locations,
      remote: r.remote,
      applyUrl: r.applyUrl,
      postedAt: r.postedAt?.toISOString() ?? null,
      createdAt: fetchedAt,
      lastSeenAt: fetchedAt,
      contentSignature: r.contentSignature,
      productionEmbeddingModel: null,
      flags: jobFlags(text),
    });
  });
  const snapshotCompanies = (await db.select().from(companies).orderBy(companies.id)).map((c) =>
    SnapshotCompanySchema.parse({
      id: c.id,
      slug: c.slug,
      source: c.source,
      name: (c.metadata as { name?: string } | null)?.name ?? null,
    }),
  );
  return { jobs: snapshotJobs, companies: snapshotCompanies, locationStrings, locations: counts };
}
