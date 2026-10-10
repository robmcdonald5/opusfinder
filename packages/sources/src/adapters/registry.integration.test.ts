import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COMPANIES_LOWER_SLUG_UQ } from "@opusfinder/db/schema";

import { createTestDb } from "@test/db/pglite";

import { CASE_INSENSITIVE_SLUG_SOURCES } from "./index";

// @opusfinder/db can't import CASE_INSENSITIVE_SLUG_SOURCES (sources depends on db), so the case-folded unique
// index keeps its own literal source list. This reads the index the MIGRATIONS build — not the drizzle schema,
// which can change with no migration generated — and fails when the two lists diverge: changing either needs
// the other AND a migration that drops and recreates the index.
describe("CASE_INSENSITIVE_SLUG_SOURCES — in sync with the migrated case-folded unique index", () => {
  let pg: PGlite;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ client: pg, close } = await createTestDb());
  });
  afterAll(async () => {
    await close?.();
  });

  it(`lists exactly the sources ${COMPANIES_LOWER_SLUG_UQ} covers`, async () => {
    const { rows } = await pg.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'companies' AND indexname = $1",
      [COMPANIES_LOWER_SLUG_UQ],
    );
    const def = rows[0]?.indexdef ?? "";
    // `CREATE UNIQUE INDEX … (source, lower(slug)) WHERE (source = ANY (ARRAY['ashby'::text, …]))`
    const where = /^CREATE UNIQUE INDEX .+ \(source, lower\(slug\)\) WHERE (.+)$/.exec(def)?.[1];
    expect(where, def).toBeDefined();
    const covered = [...where!.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(covered).toEqual([...CASE_INSENSITIVE_SLUG_SOURCES].sort());
  });
});
