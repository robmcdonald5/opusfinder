import { sql } from "drizzle-orm";

import { runScript } from "@opusfinder/shared/script";

import { createDb } from "../src/client";
import { getDatabaseUrl } from "../src/env";
import { resultRows } from "../src/repos/sql";

/**
 * Phase F4 enrichment status — the PHASE_F4_PLAN.md §9 gate query at a glance: how many jobs are enriched,
 * still pending, carry a YoE / salary, or were extracted-found-nothing. The marker (`enriched_at`), NOT the
 * data columns, drives "done", so `pending` → 0 after a full `pnpm enrich:backfill`; `enriched_empty` counts
 * the legitimately-extracted-found-nothing rows (content present, no comp/years in the prose). Mirrors
 * `pnpm runs` / `delivery` — read-only, counts only, no row content echoed.
 *
 *   pnpm --filter @opusfinder/db enrichment
 */
await runScript("ShowEnrichment", async () => {
  const db = createDb(getDatabaseUrl());
  const result = await db.execute(sql`
    SELECT count(*)                                                       AS total,
           count(*) FILTER (WHERE enriched_at IS NULL)                    AS pending,
           count(*) FILTER (WHERE yoe_min IS NOT NULL OR yoe_max IS NOT NULL) AS with_yoe,
           count(*) FILTER (WHERE salary_min IS NOT NULL)                 AS with_salary,
           count(*) FILTER (WHERE enriched_at IS NOT NULL
                              AND yoe_min IS NULL AND yoe_max IS NULL
                              AND salary_min IS NULL)                      AS enriched_empty
    FROM jobs
  `);
  const row = resultRows(result)[0] as Record<string, unknown> | undefined;
  if (!row) {
    console.log("No jobs in the table.");
    return;
  }
  const n = (k: string) => Number(row[k]);
  console.log(
    `jobs total=${n("total")}  pending(enriched_at NULL)=${n("pending")}  ` +
      `with_yoe=${n("with_yoe")}  with_salary=${n("with_salary")}  enriched_empty=${n("enriched_empty")}`,
  );
});
