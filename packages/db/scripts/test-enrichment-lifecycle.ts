import { PgDialect } from "drizzle-orm/pg-core";

import type { JobEnrichment } from "@opusfinder/shared";
import { runScript } from "@opusfinder/shared/script";

import type { Db } from "../src/client";
import {
  type EnrichmentDeps,
  type ExtractFn,
  drainEnrichment,
  writeJobEnrichment,
} from "../src/repos/enrichment";

/**
 * Stub smoke for the Phase-F4 enrichment lifecycle (4c) — the JS-decidable surface, NO creds, NO Postgres.
 * Two halves, mirroring test-lifecycle-sweep:
 *   A. writeJobEnrichment: a fake Db records the execute() call and the emitted SQL is rendered with
 *      PgDialect, asserting the write stamps `enriched_at = now()`, never touches `updated_at`, casts every
 *      VALUES column, sets all six data columns, and NUL-strips the free-text `salary_currency`.
 *   B. drainEnrichment: a fake { fetch, write } over an in-memory table + a stub extractor assert the loop's
 *      safety-critical logic — every successful row is written+stamped, a comp-less (all-NULL) extraction is
 *      STILL stamped (the SENTINEL, not the data, marks "done"), a THROWING extraction is left un-stamped and
 *      SKIPPED, and the keyset cursor advances past it so a persistently-failing row CANNOT wedge the loop
 *      (the run terminates; the next run re-attempts it once).
 * The SQL *semantics* (the actual UPDATE against a real table, and the upsertJobs reset CASE) are the live
 * gate's job (4d + the post-migrate SQL check, PHASE_F4_PLAN.md §9).
 *
 *   pnpm --filter @opusfinder/db test:enrichment
 */
const NUL = String.fromCharCode(0);
const dialect = new PgDialect();

/** A fake Db that records execute() calls and returns a canned result — no Postgres, no creds. */
function stubDb(canned: unknown): { db: Db; calls: unknown[] } {
  const calls: unknown[] = [];
  const db = {
    execute: async (query: unknown) => {
      calls.push(query);
      return canned;
    },
  } as unknown as Db;
  return { db, calls };
}

function rendered(query: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]);
}

const EMPTY_ENRICHMENT: JobEnrichment = {
  yoeMin: null,
  yoeMax: null,
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryPeriod: null,
};

await runScript("test-enrichment-lifecycle", async () => {
  // ── A. writeJobEnrichment SQL shape ──────────────────────────────────────────────────────────────
  // 1) One UPDATE per chunk: stamps enriched_at=now(), leaves updated_at alone, casts every column, sets all
  //    six data columns, and NUL-strips salary_currency (the lone free-text column).
  {
    const { db, calls } = stubDb([{ id: 1 }, { id: 2 }]);
    const n = await writeJobEnrichment(db, [
      {
        id: 1,
        enrichment: {
          yoeMin: 3,
          yoeMax: 6,
          salaryMin: 120000,
          salaryMax: 150000,
          salaryCurrency: `US${NUL}D`,
          salaryPeriod: "year",
        },
      },
      { id: 2, enrichment: EMPTY_ENRICHMENT },
    ]);
    assert(calls.length === 1, "one UPDATE statement per chunk");
    const { sql: text, params } = rendered(calls[0]);
    assert(text.includes("enriched_at = now()"), "must stamp enriched_at = now()");
    assert(!/\bupdated_at\b/.test(text), "must NOT touch updated_at (enrichment is derived)");
    assert(
      text.includes("::smallint") && text.includes("::int") && text.includes("::text"),
      "every VALUES column must carry an explicit ::type cast",
    );
    assert(
      text.includes("salary_currency = v.salary_currency") && text.includes("salary_period = v.salary_period"),
      "must set all six data columns",
    );
    const cur = params.find((p) => typeof p === "string" && p.includes("US")) as string | undefined;
    assert(cur === "USD", `salary_currency must be NUL-stripped to "USD", got ${JSON.stringify(cur)}`);
    assert(
      !params.some((p) => typeof p === "string" && p.includes(NUL)),
      "no param may carry a NUL byte",
    );
    assert(n === 2, "returns the RETURNING row count");
  }

  // 2) Empty rows: no statement, zero written.
  {
    const { db, calls } = stubDb([]);
    const n = await writeJobEnrichment(db, []);
    assert(calls.length === 0 && n === 0, "empty rows must not hit the DB and return 0");
  }

  // ── B. drainEnrichment loop ──────────────────────────────────────────────────────────────────────
  interface Row {
    id: number;
    title: string;
    descriptionText: string;
    enrichedAt: number | null;
    enrichment?: JobEnrichment;
  }
  function makeTable(): Row[] {
    return [
      { id: 1, title: "Engineer", descriptionText: "5+ years", enrichedAt: null },
      { id: 2, title: "Engineer II", descriptionText: "build things", enrichedAt: null },
      { id: 3, title: "THROW", descriptionText: "always fails extraction", enrichedAt: null },
      { id: 4, title: "EMPTY", descriptionText: "no comp or years stated", enrichedAt: null },
      { id: 5, title: "Engineer V", descriptionText: "more things", enrichedAt: null },
    ];
  }
  function makeDeps(table: Row[]): { deps: EnrichmentDeps; stamped: () => number } {
    let stampCounter = 0;
    const deps: EnrichmentDeps = {
      fetch: async (afterId, limit) =>
        table
          .filter(
            (r) =>
              r.enrichedAt === null &&
              r.id > afterId &&
              (r.title.trim() !== "" || r.descriptionText.trim() !== ""),
          )
          .sort((a, b) => a.id - b.id)
          .slice(0, limit)
          .map((r) => ({ id: r.id, title: r.title, descriptionText: r.descriptionText })),
      write: async (rows) => {
        for (const { id, enrichment } of rows) {
          const row = table.find((r) => r.id === id);
          if (row) {
            row.enrichedAt = ++stampCounter;
            row.enrichment = enrichment;
          }
        }
        return rows.length;
      },
    };
    return { deps, stamped: () => stampCounter };
  }
  const extract: ExtractFn = async (job) => {
    if (job.title === "THROW") throw new Error("boom");
    if (job.title === "EMPTY") return EMPTY_ENRICHMENT;
    return { ...EMPTY_ENRICHMENT, yoeMin: 3, yoeMax: 6 };
  };

  // 3) Run 1: 4 enriched + 1 failed; the throwing row stays NULL, the comp-less row is stamped with all-NULL
  //    data, the rest are stamped. Termination itself proves the keyset advances past the failing row.
  const table = makeTable();
  const { deps } = makeDeps(table);
  const r1 = await drainEnrichment(extract, deps, { batchSize: 2 });
  assert(r1.enriched === 4, `run1 enriched should be 4, got ${r1.enriched}`);
  assert(r1.failed === 1, `run1 failed should be 1, got ${r1.failed}`);
  const row = (id: number) => table.find((r) => r.id === id)!;
  assert(row(3).enrichedAt === null, "throwing row 3 must be left un-stamped");
  assert(row(4).enrichedAt !== null, "comp-less row 4 must be stamped (sentinel marks done, not data)");
  assert(
    row(4).enrichment!.salaryMin === null && row(4).enrichment!.yoeMin === null,
    "comp-less row 4 must be written with all-NULL data",
  );
  assert([1, 2, 5].every((id) => row(id).enrichedAt !== null), "rows 1/2/5 must be stamped");

  // 4) Run 2 (idempotent): only the still-NULL row 3 is re-attempted (throws again); loop still terminates.
  const r2 = await drainEnrichment(extract, deps, { batchSize: 2 });
  assert(r2.enriched === 0, `run2 enriched should be 0, got ${r2.enriched}`);
  assert(r2.failed === 1, `run2 must re-attempt the still-failing row exactly once, got ${r2.failed}`);

  console.log(
    "test-enrichment-lifecycle OK — writeJobEnrichment stamps enriched_at=now(), skips updated_at, casts " +
      "every column, NUL-strips salary_currency; drain loop writes+stamps successes (incl. all-NULL), skips a " +
      "throwing row, keyset-terminates without re-selecting it, and re-attempts it on the next run.",
  );
});

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
