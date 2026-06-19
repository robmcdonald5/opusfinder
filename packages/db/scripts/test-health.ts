import { PgDialect } from "drizzle-orm/pg-core";

import { runScript } from "@opusfinder/shared/script";

import type { Db } from "../src/client";
import {
  type HealthCheck,
  type HealthCheckId,
  type HealthReport,
  type HealthSignals,
  evaluateHealth,
  healthOptionsFromEnv,
} from "../src/health";
import { recordHealthAlert, shouldNotify } from "../src/repos/health-alerts";

/**
 * Stub smoke for the Phase-F6 health checker (F6b) — the JS-decidable surface, NO creds, NO Postgres.
 * Exercises the PURE evaluator `evaluateHealth(signals, opts)` directly with canned signal shapes (the
 * point of the gather/evaluate split: no db stub needed), plus `healthOptionsFromEnv` parsing. Asserts:
 *   - a healthy signal set fires nothing and is not `unhealthy`;
 *   - each of the seven checks fires on its own breach shape (incl. the status='ok' all-board-failed
 *     trap and an errored ingestion run) and stays quiet otherwise;
 *   - `shadow` firings are reported but NEVER set `unhealthy`; `enforce` firings DO; `off` skips;
 *   - the board fail-ratio does not divide by zero on an empty (0-company) tick;
 *   - null ages (pipeline never ran) fire the staleness/window checks;
 *   - the cost rollup computes cache-hit-rate (and null when there is no rerank traffic).
 * The live verdict over real Neon (`pnpm health`) is F6c's job.
 *
 *   pnpm --filter @opusfinder/db test:health
 */

const HEALTHY: HealthSignals = {
  ingestionAgeH: 0.5,
  latestIngestStatus: "ok",
  latestIngestFailed: 0,
  latestIngestCompanies: 11,
  discoveryAgeD: 1,
  discoveryLaneErrors: 0,
  embeddingBacklog: 0,
  digestErrors: 0,
  hardBounces: 0,
  suppressed: 0,
  cost: { digestsConsidered: 3, rerankCacheReadTokens: 900, rerankCacheCreationTokens: 100 },
};

/** A single-check breach shape: override(s) on HEALTHY that should trip exactly `id`. */
const BREACHES: Array<{ id: HealthCheckId; over: Partial<HealthSignals> }> = [
  { id: "ingestion_staleness", over: { ingestionAgeH: 10 } },
  // every board 404'd but the run stayed status='ok' → failed == companies → ratio 1.0 > 0.5.
  { id: "board_fail_ratio", over: { latestIngestFailed: 11, latestIngestCompanies: 11 } },
  { id: "discovery_window", over: { discoveryAgeD: 30 } },
  { id: "embedding_backlog", over: { embeddingBacklog: 5000 } },
  { id: "digest_health", over: { digestErrors: 2 } },
  { id: "bounce_suppression", over: { hardBounces: 1 } },
  { id: "discovery_lane_errors", over: { discoveryLaneErrors: 2 } },
];

const find = (r: HealthReport, id: HealthCheckId) => {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`assertion failed: report missing check "${id}"`);
  return c;
};

await runScript("test-health", async () => {
  // 1) Healthy signals: nothing fires, not unhealthy, all seven checks present.
  {
    const r = evaluateHealth(HEALTHY);
    assert(r.checks.length === 7, `expected 7 checks, got ${r.checks.length}`);
    assert(!r.unhealthy, "healthy signals must not be unhealthy");
    assert(r.checks.every((c) => c.state === "ok"), "healthy signals must leave every check ok");
  }

  // 2) Each check: breach fires only itself; shadow never pages; enforce pages; off skips.
  for (const { id, over } of BREACHES) {
    const signals = { ...HEALTHY, ...over };

    // shadow (default): the check fires, but unhealthy stays false; no OTHER check fires.
    const shadow = evaluateHealth(signals);
    assert(find(shadow, id).state === "firing", `${id}: must fire on its breach shape`);
    assert(!shadow.unhealthy, `${id}: a shadow firing must NOT set unhealthy`);
    assert(
      shadow.checks.filter((c) => c.state === "firing").length === 1,
      `${id}: breach must trip exactly one check, not others`,
    );

    // enforce: the same breach now sets unhealthy.
    const enforce = evaluateHealth(signals, { modes: { [id]: "enforce" } });
    assert(find(enforce, id).state === "firing", `${id}: still fires under enforce`);
    assert(enforce.unhealthy, `${id}: an enforce firing MUST set unhealthy`);

    // off: the check is skipped and cannot contribute to unhealthy.
    const off = evaluateHealth(signals, { modes: { [id]: "off" } });
    assert(find(off, id).state === "skipped", `${id}: off mode must skip the check`);
    assert(!off.unhealthy, `${id}: an off check must never set unhealthy`);
  }

  // 3) Board fail-ratio must not divide by zero on an empty (0-company) tick.
  {
    const r = evaluateHealth({ ...HEALTHY, latestIngestFailed: 5, latestIngestCompanies: 0 });
    assert(find(r, "board_fail_ratio").state === "ok", "0-company tick must not fire fail-ratio");
    assert(find(r, "board_fail_ratio").metric === 0, "0-company fail-ratio metric must be 0, not NaN");
  }

  // 4) Null ages (pipeline never ran) fire the age checks.
  {
    const r = evaluateHealth({ ...HEALTHY, ingestionAgeH: null, discoveryAgeD: null });
    assert(find(r, "ingestion_staleness").state === "firing", "null ingestion age must fire");
    assert(find(r, "discovery_window").state === "firing", "null discovery age must fire");
  }

  // 5) Cost rollup: cache-hit-rate from named keys; null when there is no rerank traffic; the raw
  //    token counts + digestsConsidered pass through unchanged (hit-rate alone only pins the ratio).
  {
    const r = evaluateHealth(HEALTHY);
    assert(r.cost.rerankCacheHitRate === 0.9, `hit-rate must be 0.9, got ${r.cost.rerankCacheHitRate}`);
    assert(r.cost.rerankCacheReadTokens === 900, "read tokens must pass through unchanged");
    assert(r.cost.rerankCacheCreationTokens === 100, "creation tokens must pass through unchanged");
    assert(r.cost.digestsConsidered === 3, "digestsConsidered must pass through unchanged");
    const zero = evaluateHealth({
      ...HEALTHY,
      cost: { digestsConsidered: 0, rerankCacheReadTokens: 0, rerankCacheCreationTokens: 0 },
    });
    assert(zero.cost.rerankCacheHitRate === null, "hit-rate must be null with no rerank tokens");
  }

  // 5b) board_fail_ratio also fires when the LATEST ingestion run errored outright (a full-run abort
  //     leaves counts.companies=0 → a 0/0 ratio that the ratio arm alone would read as healthy).
  {
    const r = evaluateHealth({ ...HEALTHY, latestIngestStatus: "error", latestIngestFailed: 0, latestIngestCompanies: 0 });
    assert(find(r, "board_fail_ratio").state === "firing", "errored latest run must fire board_fail_ratio");
  }

  // 5c) board_fail_ratio threshold boundary (default 0.5): 5/11 (~0.45) ok, 6/11 (~0.55) fires, and the
  //     metric carries the real partial ratio (not 0).
  {
    const under = evaluateHealth({ ...HEALTHY, latestIngestFailed: 5, latestIngestCompanies: 11 });
    assert(find(under, "board_fail_ratio").state === "ok", "5/11 (~0.45) must stay under the 0.5 watermark");
    const over = evaluateHealth({ ...HEALTHY, latestIngestFailed: 6, latestIngestCompanies: 11 });
    assert(find(over, "board_fail_ratio").state === "firing", "6/11 (~0.55) must breach the 0.5 watermark");
    assert(
      Math.abs((find(over, "board_fail_ratio").metric ?? 0) - 6 / 11) < 1e-9,
      "metric must be the real partial ratio, not 0",
    );
  }

  // 5d) unhealthy aggregation is `.some(enforce && firing)`: a shadow firing alongside an enforce firing
  //     stays unhealthy via the enforce one; two enforce firings stay unhealthy; all-shadow never is.
  {
    const twoBreached = { ...HEALTHY, embeddingBacklog: 5000, digestErrors: 2 };
    assert(!evaluateHealth(twoBreached).unhealthy, "two shadow firings must NOT be unhealthy");
    assert(
      evaluateHealth(twoBreached, { modes: { embedding_backlog: "enforce" } }).unhealthy,
      "one enforce firing among shadow firings must be unhealthy",
    );
    assert(
      evaluateHealth(twoBreached, { modes: { embedding_backlog: "enforce", digest_health: "enforce" } })
        .unhealthy,
      "two enforce firings must be unhealthy",
    );
  }

  // 6) healthOptionsFromEnv: CSV mode lists + threshold overrides; invalid ids ignored.
  {
    const opts = healthOptionsFromEnv({
      HEALTH_ENFORCE: "embedding_backlog, ingestion_staleness, not_a_real_check",
      HEALTH_OFF: "discovery_window",
      HEALTH_BACKLOG_MAX: "100",
      HEALTH_FAIL_RATIO: "", // blank must fall through to the default, not NaN
      HEALTH_DISCOVERY_MAX_AGE_D: "-1", // negative must be rejected (would invert a high-watermark check)
    });
    assert(opts.modes?.embedding_backlog === "enforce", "HEALTH_ENFORCE must mark embedding_backlog enforce");
    assert(opts.modes?.ingestion_staleness === "enforce", "HEALTH_ENFORCE must mark ingestion_staleness enforce");
    assert(opts.modes?.discovery_window === "off", "HEALTH_OFF must mark discovery_window off");
    assert(!("not_a_real_check" in (opts.modes ?? {})), "invalid check ids must be ignored");
    assert(opts.thresholds?.backlogMax === 100, "HEALTH_BACKLOG_MAX must override backlogMax");
    assert(!("failRatio" in (opts.thresholds ?? {})), "a blank threshold must not override the default");
    assert(!("discoveryMaxAgeD" in (opts.thresholds ?? {})), "a negative threshold must be rejected, not applied");

    // and the parsed opts drive evaluateHealth as expected: backlog 150 > 100 now fires + enforces.
    const r = evaluateHealth({ ...HEALTHY, embeddingBacklog: 150 }, opts);
    assert(r.unhealthy, "parsed enforce + lowered threshold must make a 150 backlog unhealthy");

    // enforce wins over off when an id appears in BOTH lists (the precedence is load-bearing on loop order).
    const both = healthOptionsFromEnv({ HEALTH_OFF: "embedding_backlog", HEALTH_ENFORCE: "embedding_backlog" });
    assert(both.modes?.embedding_backlog === "enforce", "enforce must win over off when an id is in both lists");
  }

  // 7) H1b dedup primitives (stubbed db, NO creds, NO Postgres): shouldNotify gates purely on the
  //    recent-row count, and recordHealthAlert writes the shape-only fields. Drives the full page-once
  //    cycle — clear → page+record → suppressed within cooldown → re-armed after — by setting the count
  //    the stub returns. (The real time-window SEMANTICS are the H1d live gate's job, like prune-oplog.)
  {
    const { db, inserts, setRecent, lastExecuteQuery } = stubAlertDb();
    const check: HealthCheck = {
      id: "ingestion_staleness",
      label: "Ingestion staleness",
      state: "firing",
      metric: 4.2,
      threshold: 3,
      mode: "enforce",
    };

    setRecent(0);
    assert(await shouldNotify(db, check.id, 24), "no recent row ⇒ clear to page");

    // shouldNotify must BIND the passed check id + cooldown (a wrong-id query would silently never dedup —
    // the order-bound orchestration smoke can't catch that, so pin the SQL shape here where PgDialect lives).
    const dialect = new PgDialect();
    const { sql: gateSql, params: gateParams } = dialect.sqlToQuery(
      lastExecuteQuery() as Parameters<typeof dialect.sqlToQuery>[0],
    );
    assert(gateSql.includes("check_id"), "shouldNotify filters on check_id");
    assert(gateSql.includes("interval '1 hour'"), "shouldNotify binds the cooldown as an hour window");
    assert(gateParams[0] === "ingestion_staleness", "shouldNotify binds the PASSED check id, not a stray one");
    assert(gateParams.includes(24), "shouldNotify binds the passed cooldown hours");

    await recordHealthAlert(db, check, "Ingestion staleness (ingestion_staleness): 4.2h since last ok [threshold 3]");
    assert(inserts.length === 1, "recordHealthAlert writes exactly one row");
    const row = inserts[0];
    assert(row !== undefined, "recordHealthAlert row is present");
    assert(row.checkId === "ingestion_staleness", "row carries the check id");
    assert(row.mode === "enforce", "row carries the mode");
    assert(row.metric === 4.2 && row.threshold === 3, "row carries the numeric metric/threshold");
    assert(typeof row.detail === "string", "detail is a string");
    assert(
      !(row.detail as string).includes("@") && !(row.detail as string).includes("http"),
      "detail is shape-only — no email address / URL leaks into the event log",
    );

    setRecent(1); // the just-paged row now sits inside the cooldown window
    assert(!(await shouldNotify(db, check.id, 24)), "a recent row within cooldown ⇒ suppress the re-page");

    setRecent(0); // cooldown elapsed / the row aged past the window
    assert(await shouldNotify(db, check.id, 24), "after the cooldown clears ⇒ re-armed to page");
  }

  console.log(
    "test-health OK — 7 checks, healthy=clean; each breach fires only itself; shadow!=unhealthy, " +
      "enforce=unhealthy (single + multi-enforce), off=skipped; board_fail_ratio fires on an errored run " +
      "and at the 0.5 boundary, no div-by-zero on empty ticks; null ages fire; cost hit-rate/null + token " +
      "pass-through; healthOptionsFromEnv parses modes/thresholds, ignores invalid ids, rejects negatives, " +
      "and enforce wins over off; H1b dedup — shouldNotify gates on the recent-row count (page → suppress " +
      "in cooldown → re-arm), recordHealthAlert writes shape-only rows.",
  );
});

/**
 * A fake Db for the H1b primitives — NO Postgres, NO creds. `recordHealthAlert` lands its `.values()`
 * object in `inserts`; `shouldNotify` reads the count `execute` returns, which `setRecent` controls so the
 * test can drive the page → suppress → re-arm cycle deterministically.
 */
function stubAlertDb(): {
  db: Db;
  inserts: Array<Record<string, unknown>>;
  setRecent: (n: number) => void;
  lastExecuteQuery: () => unknown;
} {
  const inserts: Array<Record<string, unknown>> = [];
  let recent = 0;
  let lastQuery: unknown;
  const db = {
    insert: () => ({ values: async (v: Record<string, unknown>) => void inserts.push(v) }),
    execute: async (q: unknown) => {
      lastQuery = q;
      return [{ n: recent }];
    },
  } as unknown as Db;
  return { db, inserts, setRecent: (n) => void (recent = n), lastExecuteQuery: () => lastQuery };
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
