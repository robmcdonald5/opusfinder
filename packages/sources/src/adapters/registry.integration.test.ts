import type { PGlite } from "@electric-sql/pglite";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { companies, COMPANIES_LOWER_SLUG_UQ } from "@opusfinder/db/schema";

import { createTestDb } from "@test/db/pglite";

import { CASE_INSENSITIVE_SLUG_SOURCES } from "./index";

// @opusfinder/db can't import CASE_INSENSITIVE_SLUG_SOURCES (sources depends on db), so the case-folded unique
// index keeps its own literal source list. This reads the index the MIGRATIONS build AND the one schema.ts
// declares (CI has no drizzle-kit drift check, so a schema lagging a hand-written migration would be reverted by
// the next `drizzle-kit generate`), and fails when any of the three lists diverge: changing one needs the
// others AND a migration that drops and recreates the index.
describe("CASE_INSENSITIVE_SLUG_SOURCES — in sync with the case-folded unique index", () => {
  let pg: PGlite;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ client: pg, close } = await createTestDb());
  });
  afterAll(async () => {
    await close?.();
  });

  /** The quoted source names in an index predicate, sorted. */
  const quoted = (predicate: string) =>
    [...predicate.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

  it(`lists exactly the sources ${COMPANIES_LOWER_SLUG_UQ} covers, as migrated and as declared`, async () => {
    const { rows } = await pg.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'companies' AND indexname = $1",
      [COMPANIES_LOWER_SLUG_UQ],
    );
    const def = rows[0]?.indexdef ?? "";
    // `CREATE UNIQUE INDEX … (source, lower(slug)) WHERE (source = ANY (ARRAY['ashby'::text, …]))`
    const where = /^CREATE UNIQUE INDEX .+ \(source, lower\(slug\)\) WHERE (.+)$/.exec(def)?.[1];
    expect(where, def).toBeDefined();
    const declared = getTableConfig(companies).indexes.find(
      (i) => i.config.name === COMPANIES_LOWER_SLUG_UQ,
    )?.config.where;
    expect(declared).toBeDefined();

    const expected = [...CASE_INSENSITIVE_SLUG_SOURCES].sort();
    expect({
      migrated: quoted(where!),
      declared: quoted(new PgDialect().sqlToQuery(declared!).sql),
    }).toEqual({ migrated: expected, declared: expected });
  });
});
