import { describe, expect, it } from "vitest";

import { render } from "@test/db/render";

import type { Db } from "./client";
import {
  evaluateHealth,
  healthOptionsFromEnv,
  type HealthCheck,
  type HealthCheckId,
  type HealthReport,
  type HealthSignals,
} from "./health";
import {
  DEFAULT_HEALTH_ALERT_COOLDOWN_H,
  recordHealthAlert,
  shouldNotify,
} from "./repos/health-alerts";

// Leaf pure-unit for the health checker. Ports scripts/test-health.ts. `evaluateHealth` is PURE (no db /
// env / clock), so every check-logic assertion feeds a canned HealthSignals literal directly — no stub.
// Only the H1b dedup primitives (shouldNotify / recordHealthAlert) touch a `Db`; a LOCAL stubAlertDb fakes
// db.insert / db.execute (NO Postgres, NO creds) and the alert-gate SQL is pinned via render() (PgDialect).
// The live verdict over real Neon stays `pnpm health`.

/** The smoke's canonical all-green signal set — every check within bounds. Cloned per case via spread. */
const HEALTHY: HealthSignals = {
  ingestionAgeH: 0.5,
  latestIngestStatus: "ok",
  latestIngestFailed: 0,
  latestIngestProcessed: 11,
  latestIngestCompanies: 11,
  discoveryAgeD: 1,
  discoveryLaneErrors: 0,
  embeddingBacklog: 0,
  digestErrors: 0,
  hardBounces: 0,
  suppressed: 0,
  cost: { digestsConsidered: 3, rerankCacheReadTokens: 900, rerankCacheCreationTokens: 100 },
};

/**
 * One breach shape per check: the minimal override(s) on HEALTHY that should trip EXACTLY that check.
 * Copied verbatim from the smoke's BREACHES table (incl. the board_fail_ratio "every attempted board
 * 404'd yet status='ok'" trap → failed == processed → ratio 1.0). Frozen so a case can't mutate it.
 */
const BREACHES: Array<{ id: HealthCheckId; signalOverride: Partial<HealthSignals> }> = [
  { id: "ingestion_staleness", signalOverride: { ingestionAgeH: 10 } },
  {
    id: "board_fail_ratio",
    signalOverride: { latestIngestFailed: 11, latestIngestProcessed: 11, latestIngestCompanies: 11 },
  },
  { id: "discovery_window", signalOverride: { discoveryAgeD: 30 } },
  { id: "embedding_backlog", signalOverride: { embeddingBacklog: 5000 } },
  { id: "digest_health", signalOverride: { digestErrors: 2 } },
  { id: "bounce_suppression", signalOverride: { hardBounces: 1 } },
  { id: "discovery_lane_errors", signalOverride: { discoveryLaneErrors: 2 } },
];
Object.freeze(BREACHES);

/** Locate a check by id, failing loudly if the report is missing it (ports the smoke's `find` helper). */
function checkOf(report: HealthReport, id: HealthCheckId): HealthCheck {
  const c = report.checks.find((x) => x.id === id);
  expect(c, `report missing check "${id}"`).toBeDefined();
  return c!;
}

describe("evaluateHealth — healthy baseline", () => {
  it("all-green signals yield exactly 7 checks, none firing, not unhealthy", () => {
    const r = evaluateHealth(HEALTHY);
    expect(r.checks).toHaveLength(7);
    expect(r.checks.every((c) => c.state === "ok")).toBe(true);
    expect(r.checks.filter((c) => c.state === "firing")).toHaveLength(0);
    expect(r.unhealthy).toBe(false);
  });
});

describe("evaluateHealth — 7-check breach matrix (each breach trips exactly its own check)", () => {
  it.each(BREACHES)(
    "$id fires only itself; shadow ≠ unhealthy, enforce = unhealthy, off = skipped",
    ({ id, signalOverride }) => {
      const signals = { ...HEALTHY, ...signalOverride };

      // Default mode is shadow: the breached check fires and ONLY it, but a shadow firing never pages.
      const shadow = evaluateHealth(signals);
      expect(checkOf(shadow, id).state).toBe("firing");
      expect(shadow.checks.filter((c) => c.state === "firing")).toHaveLength(1);
      expect(shadow.unhealthy).toBe(false);

      // enforce: same firing, but now it sets unhealthy.
      const enforce = evaluateHealth(signals, { modes: { [id]: "enforce" } });
      expect(checkOf(enforce, id).state).toBe("firing");
      expect(enforce.unhealthy).toBe(true);

      // off: the check is skipped (not computed) and can never set unhealthy.
      const off = evaluateHealth(signals, { modes: { [id]: "off" } });
      expect(checkOf(off, id).state).toBe("skipped");
      expect(off.unhealthy).toBe(false);
    },
  );
});

describe("evaluateHealth — null ages (pipeline never ran) fire the age checks", () => {
  it("a null ingestion age and a null discovery age both fire", () => {
    const r = evaluateHealth({ ...HEALTHY, ingestionAgeH: null, discoveryAgeD: null });
    expect(checkOf(r, "ingestion_staleness").state).toBe("firing");
    expect(checkOf(r, "discovery_window").state).toBe("firing");
  });
});

describe("evaluateHealth — board_fail_ratio edges", () => {
  it("a 0-processed / 0-companies tick stays ok with metric 0 (no divide-by-zero NaN)", () => {
    const r = evaluateHealth({
      ...HEALTHY,
      latestIngestFailed: 5,
      latestIngestProcessed: 0,
      latestIngestCompanies: 0,
    });
    expect(checkOf(r, "board_fail_ratio").state).toBe("ok");
    expect(checkOf(r, "board_fail_ratio").metric).toBe(0);
  });

  it("an errored latest run fires even at 0/0 (the status arm catches a full-run abort)", () => {
    const r = evaluateHealth({
      ...HEALTHY,
      latestIngestStatus: "error",
      latestIngestFailed: 0,
      latestIngestProcessed: 0,
      latestIngestCompanies: 0,
    });
    expect(checkOf(r, "board_fail_ratio").state).toBe("firing");
  });

  it("holds the 0.5 boundary: 5/11 (~0.45) ok, 6/11 (~0.55) fires with the real ratio as metric", () => {
    const under = evaluateHealth({ ...HEALTHY, latestIngestFailed: 5, latestIngestCompanies: 11 });
    expect(checkOf(under, "board_fail_ratio").state).toBe("ok");

    const over = evaluateHealth({ ...HEALTHY, latestIngestFailed: 6, latestIngestCompanies: 11 });
    expect(checkOf(over, "board_fail_ratio").state).toBe("firing");
    expect(checkOf(over, "board_fail_ratio").metric).toBeCloseTo(6 / 11, 9);
  });

  it("a budget-truncated tick divides by processed, NOT companies", () => {
    // 30 of 150 boards attempted, all 30 failed → 30/30 = 1.0 fires; failed/companies (0.2) would stay silent.
    const allFailed = evaluateHealth({
      ...HEALTHY,
      latestIngestFailed: 30,
      latestIngestProcessed: 30,
      latestIngestCompanies: 150,
    });
    expect(checkOf(allFailed, "board_fail_ratio").state).toBe("firing");
    expect(checkOf(allFailed, "board_fail_ratio").metric).toBeCloseTo(1, 9);

    // A few failures among the attempted boards (3/30 = 0.1) stays under the watermark.
    const fewFailed = evaluateHealth({
      ...HEALTHY,
      latestIngestFailed: 3,
      latestIngestProcessed: 30,
      latestIngestCompanies: 150,
    });
    expect(checkOf(fewFailed, "board_fail_ratio").state).toBe("ok");
  });
});

describe("evaluateHealth — cost rollup", () => {
  it("computes rerankCacheHitRate 0.9 for read 900 / creation 100 and passes tokens through", () => {
    const r = evaluateHealth(HEALTHY);
    expect(r.cost.rerankCacheHitRate).toBe(0.9);
    expect(r.cost.rerankCacheReadTokens).toBe(900);
    expect(r.cost.rerankCacheCreationTokens).toBe(100);
    expect(r.cost.digestsConsidered).toBe(3);
  });

  it("hit-rate is null when there is no rerank traffic (all tokens 0)", () => {
    const r = evaluateHealth({
      ...HEALTHY,
      cost: { digestsConsidered: 0, rerankCacheReadTokens: 0, rerankCacheCreationTokens: 0 },
    });
    expect(r.cost.rerankCacheHitRate).toBeNull();
  });
});

describe("evaluateHealth — unhealthy aggregation = some(enforce && firing)", () => {
  // Two checks breached at once, so the aggregation over modes is exercised (not a single firing).
  const twoBreached: HealthSignals = { ...HEALTHY, embeddingBacklog: 5000, digestErrors: 2 };

  it("two shadow firings are NOT unhealthy", () => {
    expect(evaluateHealth(twoBreached).unhealthy).toBe(false);
  });

  it("one enforce firing among shadow firings IS unhealthy", () => {
    expect(evaluateHealth(twoBreached, { modes: { embedding_backlog: "enforce" } }).unhealthy).toBe(true);
  });

  it("two enforce firings ARE unhealthy", () => {
    expect(
      evaluateHealth(twoBreached, {
        modes: { embedding_backlog: "enforce", digest_health: "enforce" },
      }).unhealthy,
    ).toBe(true);
  });
});

describe("healthOptionsFromEnv — HEALTH_* env → options (explicit env record, never process.env)", () => {
  const opts = healthOptionsFromEnv({
    HEALTH_ENFORCE: "embedding_backlog, ingestion_staleness, not_a_real_check",
    HEALTH_OFF: "discovery_window",
    HEALTH_BACKLOG_MAX: "100",
    HEALTH_FAIL_RATIO: "", // blank must fall through to the default, not NaN
    HEALTH_DISCOVERY_MAX_AGE_D: "-1", // negative must be rejected (would invert a high-watermark check)
  });

  it("maps HEALTH_ENFORCE / HEALTH_OFF CSV to modes and drops invalid ids", () => {
    expect(opts.modes?.embedding_backlog).toBe("enforce");
    expect(opts.modes?.ingestion_staleness).toBe("enforce");
    expect(opts.modes?.discovery_window).toBe("off");
    expect("not_a_real_check" in (opts.modes ?? {})).toBe(false);
  });

  it("HEALTH_BACKLOG_MAX=100 overrides backlogMax", () => {
    expect(opts.thresholds?.backlogMax).toBe(100);
  });

  it("a blank HEALTH_FAIL_RATIO does not override the default (no NaN)", () => {
    expect("failRatio" in (opts.thresholds ?? {})).toBe(false);
  });

  it("a negative HEALTH_DISCOVERY_MAX_AGE_D is rejected, not applied", () => {
    expect("discoveryMaxAgeD" in (opts.thresholds ?? {})).toBe(false);
  });

  it("enforce wins over off when an id appears in both lists", () => {
    const both = healthOptionsFromEnv({
      HEALTH_OFF: "embedding_backlog",
      HEALTH_ENFORCE: "embedding_backlog",
    });
    expect(both.modes?.embedding_backlog).toBe("enforce");
  });

  it("the parsed opts drive evaluateHealth: backlog 150 > 100 fires + enforces → unhealthy", () => {
    expect(evaluateHealth({ ...HEALTHY, embeddingBacklog: 150 }, opts).unhealthy).toBe(true);
  });
});

describe("alert gate — shouldNotify / recordHealthAlert page-once-per-cooldown dedup (stubAlertDb)", () => {
  const check: HealthCheck = {
    id: "ingestion_staleness",
    label: "Ingestion staleness",
    state: "firing",
    metric: 4.2,
    threshold: 3,
    mode: "enforce",
  };

  it("gates on the recent-row count: clear → suppressed within cooldown → re-armed", async () => {
    const { db, setRecent } = stubAlertDb();

    setRecent(0); // no recent row ⇒ clear to page
    expect(await shouldNotify(db, check.id, DEFAULT_HEALTH_ALERT_COOLDOWN_H)).toBe(true);

    setRecent(1); // the just-paged row now sits inside the cooldown window ⇒ suppress
    expect(await shouldNotify(db, check.id, DEFAULT_HEALTH_ALERT_COOLDOWN_H)).toBe(false);

    setRecent(0); // cooldown elapsed / the row aged past the window ⇒ re-armed
    expect(await shouldNotify(db, check.id, DEFAULT_HEALTH_ALERT_COOLDOWN_H)).toBe(true);
  });

  it("recordHealthAlert writes exactly one shape-only row mapping the check fields verbatim", async () => {
    const { db, inserts } = stubAlertDb();

    await recordHealthAlert(
      db,
      check,
      "Ingestion staleness (ingestion_staleness): 4.2h since last ok [threshold 3]",
    );

    expect(inserts).toHaveLength(1);
    const row = inserts[0]!;
    // Exactly the shape-only fields — a structural subset of a HealthCheck plus the caller's detail line.
    expect(Object.keys(row).sort()).toEqual(["checkId", "detail", "metric", "mode", "threshold"]);
    expect(row).toMatchObject({
      checkId: "ingestion_staleness",
      mode: "enforce",
      metric: 4.2,
      threshold: 3,
    });
    expect(typeof row.detail).toBe("string");
    // No no-PII/URL assertion here on purpose: recordHealthAlert stores `detail` VERBATIM, so a
    // not.toContain("@"/"http") check would only re-test the literal this test itself passed in (vacuous).
    // The no-PII invariant belongs to the detail BUILDER in the caller (@opusfinder/inngest health-alert)
    // and is to be covered there (Phase 4), not at this store-verbatim primitive.
  });

  it("binds the passed check id + cooldown into the gate SQL (rendered via PgDialect)", async () => {
    const { db, lastExecuteQuery } = stubAlertDb();

    await shouldNotify(db, check.id, DEFAULT_HEALTH_ALERT_COOLDOWN_H);

    const { sql, params } = render(lastExecuteQuery() as Parameters<typeof render>[0]);
    expect(sql).toContain("check_id");
    expect(sql).toContain("count(*)");
    expect(sql).toContain("interval '1 hour'");
    // Positive lock on the read DIRECTION: recent rows are `created_at > now() - window` (NOT `<`), so a
    // row that landed inside the cooldown is what suppresses the re-page. Structural regex, not a full
    // toBe, since surrounding spacing/rendering isn't pinned.
    expect(sql).toMatch(/created_at\s*>\s*now\(\)/);
    // Exact bound VALUES + ORDER: check_id first, cooldown hours second. Literal 24 (not the constant) so
    // this locks the actual numeric window the caller passed (DEFAULT_HEALTH_ALERT_COOLDOWN_H) end-to-end.
    expect(params).toEqual(["ingestion_staleness", 24]);
  });
});

/**
 * A fake Db for the H1b primitives — NO Postgres, NO creds. Single consumer (this suite), so it lives here
 * rather than in the shared helpers. `recordHealthAlert` lands its `.values()` object in `inserts`;
 * `shouldNotify` reads the count `execute` returns, which `setRecent` controls so a test can drive the
 * page → suppress → re-arm cycle deterministically. `lastExecuteQuery` exposes the captured drizzle `sql`
 * object for render() to pin the gate SQL text/params.
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
