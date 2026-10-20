/**
 * A local copy of the `places` gazetteer for eval:locations: an in-process PGlite with the real
 * migrations, loaded with the GeoNames rows places:load would write. The eval then runs the production
 * GeoNames check against it, with no database credential and no production read.
 */
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { schema, type Db } from "@opusfinder/db";
import { loadGeonames } from "@opusfinder/db/geonames-files";
import { upsertPlaces } from "@opusfinder/db/repos";

const MIGRATIONS = fileURLToPath(new URL("../../db/drizzle", import.meta.url));

export interface LocalGazetteer {
  db: Db;
  places: number;
  close: () => Promise<void>;
}

/** Build the gazetteer from the GeoNames files in `from`, or downloaded when `from` is omitted. */
export async function openLocalGazetteer(opts: { from?: string } = {}): Promise<LocalGazetteer> {
  const { rows } = await loadGeonames(opts);
  const client = new PGlite({ extensions: { vector } });
  const pglite = drizzle(client, { schema });
  await migrate(pglite, { migrationsFolder: MIGRATIONS });
  // The PGlite client runs every repo query the check makes (typed builder + raw execute); `Db` is the
  // neon-http type, the same cast the PGlite test fixture makes.
  const db = pglite as unknown as Db;
  return { db, places: await upsertPlaces(db, rows), close: () => client.close() };
}
