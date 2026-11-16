/**
 * Add the US public-sector slice to an exported snapshot: fetch USAJOBS and NYC Jobs once (see
 * src/snapshot/public-fetch.ts for the feeds and their terms), write them through production's job
 * and place-check code in a local database, and save them as the snapshot's `public` parts.
 *
 *   pnpm --filter @opusfinder/eval snapshot:fetch-public -- --id 2026-11-16
 *
 * A one-off for the eval, not an ingest adapter: nothing is written to production. The raw feed
 * responses are kept under work/public-raw/ and reused by a re-run, so the slice is built from one
 * fetch. Needs USAJOBS_API_KEY and USAJOBS_USER_AGENT in packages/eval/.env for the first run.
 * Prints counts, never posting text.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { schema, type Db } from "@opusfinder/db";
import { places } from "@opusfinder/db/schema";
import { runScript } from "@opusfinder/shared/script";

import { getFlag } from "../src/cli";
import { relativeToPkg } from "../src/runner";
import {
  decodeJsonl,
  encodeJsonl,
  JOBS_PER_PART,
  jobsPartPath,
  SnapshotPlaceSchema,
  tablePartPath,
} from "../src/snapshot/format";
import { fetchNycJobs, fetchUsajobs, PUBLIC_SELECTION } from "../src/snapshot/public-fetch";
import { nycPostings, usajobsPosting, type PublicPosting } from "../src/snapshot/public-jobs";
import { buildPublicSlice } from "../src/snapshot/public-slice";
import type { SliceRecord } from "../src/snapshot/publish";
import { listObjects, readObject, snapshotPaths, writeObject } from "../src/snapshot/store";

const MIGRATIONS = fileURLToPath(new URL("../../db/drizzle", import.meta.url));

async function main(): Promise<void> {
  const id = getFlag(process.argv.slice(2), "--id");
  if (!id) throw new Error("--id <snapshot date> is required.");
  const paths = snapshotPaths(id);
  const record = join(paths.work, "slice-public.json");
  if (existsSync(record)) {
    throw new Error(`snapshot ${id} already has its public slice (${relativeToPkg(record)}).`);
  }
  const placeParts = listObjects(paths.objects).filter((p) => p.startsWith("places/"));
  if (placeParts.length === 0)
    throw new Error(`snapshot ${id} has no places yet; run the export first.`);

  // 1. The feeds, fetched once.
  const rawDir = join(paths.work, "public-raw");
  const raw = (name: string) => join(rawDir, `${name}.json`);
  if (!existsSync(raw("fetched-at"))) {
    mkdirSync(rawDir, { recursive: true });
    const fetchedAt = new Date().toISOString();
    writeFileSync(raw("nyc"), JSON.stringify(await fetchNycJobs((line) => console.error(line))));
    writeFileSync(
      raw("usajobs"),
      JSON.stringify(await fetchUsajobs((line) => console.error(line))),
    );
    writeFileSync(raw("fetched-at"), JSON.stringify({ fetchedAt }));
  }
  const read = (name: string) => JSON.parse(readFileSync(raw(name), "utf8")) as unknown;
  const { fetchedAt } = read("fetched-at") as { fetchedAt: string };
  const usajobsItems = read("usajobs") as unknown[];
  const nycRows = read("nyc") as unknown[];

  // 2. A local database with production's schema and the snapshot's places.
  const client = new PGlite({ extensions: { vector } });
  try {
    const pglite = drizzle(client, { schema });
    await migrate(pglite, { migrationsFolder: MIGRATIONS });
    const db = pglite as unknown as Db;
    const countryCodes = new Map<string, string>();
    let placeCount = 0;
    for (const part of placeParts) {
      const rows = decodeJsonl(readObject(paths.objects, part), SnapshotPlaceSchema, part);
      for (const p of rows)
        if (p.kind === "country") countryCodes.set(p.name.toLowerCase(), p.countryCode);
      for (let i = 0; i < rows.length; i += 1000) {
        await db.insert(places).values(rows.slice(i, i + 1000) as (typeof places.$inferInsert)[]);
      }
      placeCount += rows.length;
      console.error(`  places loaded: ${placeCount}`);
    }

    // 3. The postings, through production's job writer and place check.
    const usajobs = usajobsItems
      .map((item) => usajobsPosting(item, countryCodes))
      .filter((p): p is PublicPosting => p !== null);
    const nyc = nycPostings(nycRows, new Date(fetchedAt));
    console.error(
      `usajobs: ${usajobs.length} postings of ${usajobsItems.length} results; ` +
        `nyc: ${nyc.length} postings of ${nycRows.length} rows`,
    );
    const slice = await buildPublicSlice(db, [...usajobs, ...nyc], fetchedAt);

    // 4. The slice's objects. A run that died part-way is cleared first.
    for (const path of listObjects(paths.objects)) {
      if (/\/public-\d{4}\./.test(path)) rmSync(join(paths.objects, path));
    }
    for (let part = 0; part * JOBS_PER_PART < slice.jobs.length; part++) {
      const page = slice.jobs.slice(part * JOBS_PER_PART, (part + 1) * JOBS_PER_PART);
      writeObject(paths.objects, jobsPartPath("public", part), encodeJsonl(page));
    }
    writeObject(
      paths.objects,
      tablePartPath("companies", 0, "public"),
      encodeJsonl(slice.companies),
    );
    writeObject(
      paths.objects,
      tablePartPath("location-strings", 0, "public"),
      encodeJsonl(slice.locationStrings),
    );
    const sliceRecord: SliceRecord = { selection: PUBLIC_SELECTION, takenAt: fetchedAt };
    writeFileSync(record, `${JSON.stringify(sliceRecord, null, 2)}\n`);

    const count = (key: (job: (typeof slice.jobs)[number]) => string[]) => {
      const out: Record<string, number> = {};
      for (const job of slice.jobs) for (const k of key(job)) out[k] = (out[k] ?? 0) + 1;
      return JSON.stringify(out);
    };
    console.error(
      `\npublic slice written to ${relativeToPkg(paths.objects)} (fetched ${fetchedAt})`,
    );
    console.error(`  jobs:             ${slice.jobs.length}`);
    console.error(`  by source:        ${count((j) => [j.source])}`);
    console.error(`  flagged:          ${count((j) => j.flags)}`);
    console.error(`  employers:        ${slice.companies.length}`);
    console.error(
      `  location strings: ${slice.locationStrings.length} ${JSON.stringify(slice.locations)}`,
    );
  } finally {
    await client.close();
  }
}

await runScript("SnapshotFetchPublic", main);
