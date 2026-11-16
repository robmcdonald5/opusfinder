import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STAGE_IDS, gateView, stageDef, stages, type StageId } from "@opusfinder/control";

// The control registry's scrapers stages copy this Worker's crons and ingest/discover sizing, but the pure
// registry can't import the Worker. The Worker can't export those constants for an import either: workerd
// rejects any named export of the main module that isn't a handler or class, so `export const INGEST_CRON`
// would fail the deploy. So this sync reads them through the Worker's REAL code path: the registry's cron
// must dispatch to its lane, the ingest knob's env var must be honoured exactly inside its range, the
// ledger rows the lanes write must carry the units their stages declare (the control Worker refuses others),
// and the registry's defaults must read as no drift against the vars wrangler.toml ships.
// dispatch.test.ts separately pins wrangler.toml's crons to the same `case` labels.
// Pipelines are stubbed; no DB or network is touched.

const mocks = vi.hoisted(() => ({
  runIngestion: vi.fn(),
  runDiscovery: vi.fn(),
  runLocationResolve: vi.fn(),
}));

vi.mock("@opusfinder/db", () => ({ createDb: () => ({ __db: "stub" }) }));
vi.mock("@opusfinder/sources", () => ({ runIngestion: mocks.runIngestion }));
vi.mock("@opusfinder/discovery", () => ({ runDiscovery: mocks.runDiscovery }));
vi.mock("@opusfinder/locations", () => ({
  runLocationResolve: mocks.runLocationResolve,
  createLocationModel: () => ({ __model: "stub" }),
}));

import wranglerToml from "../wrangler.toml?raw";
import worker from "./index";

const scheduled = worker.scheduled as unknown as (
  controller: { cron: string },
  env: Record<string, unknown>,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
) => Promise<void>;

/** One tick of `cron`, settling what it hands to ctx.waitUntil (the ledger write runs there). */
async function tick(cron: string, env: Record<string, unknown> = {}): Promise<void> {
  const kv = { get: async () => null, put: async () => undefined };
  const pending: Promise<unknown>[] = [];
  await scheduled(
    { cron },
    { DATABASE_URL: "postgres://stub", INGEST_CURSOR: kv, ...env },
    { waitUntil: (promise) => void pending.push(promise) },
  );
  await Promise.all(pending);
}

// Complete pipeline counts, so each tick's ledger row can be built.
const INGEST_COUNTS = {
  processed: 1,
  companies: 1,
  lastId: 1,
  failed: 0,
  rateLimitSkipped: 0,
  changed: 0,
};
const DISCOVERY_COUNTS = { candidates: 0, probed: 0, upserted: 0, reprobed: 0, deactivated: 0 };
const LOCATION_RESULT = {
  stopped: "drained",
  failedPairs: [],
  counts: {
    pending: 1,
    asked: 1,
    resolved: 1,
    unanswered: 0,
    failed: 0,
    unmatchedPlaces: 0,
    inputTokens: 300,
    outputTokens: 40,
    cacheReadTokens: 3000,
    cacheCreationTokens: 0,
    costUsd: 0.0001,
  },
};
// The location lane runs only when its switch says so (wrangler.toml ships it off).
const LOCATIONS_ON = { LOCATIONS: "on", OPENROUTER_API_KEY: "sk-or-stub" };

const argsOf = (fn: typeof mocks.runIngestion) =>
  fn.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;

/**
 * The board limit one ingest tick runs with when the knob's env var holds `raw` (unset when undefined).
 * Cleared first and asserted to have run exactly once: a tick that skipped ingestion must fail here, not
 * hand back the previous call's limit.
 */
async function ingestLimit(raw?: string): Promise<unknown> {
  const knob = stages.ingest.knobs.boardsPerTick;
  mocks.runIngestion.mockClear();
  await tick(stages.ingest.trigger.cron, raw === undefined ? {} : { [knob.legacyEnv]: raw });
  expect(mocks.runIngestion).toHaveBeenCalledTimes(1);
  return argsOf(mocks.runIngestion)?.limit;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runIngestion.mockResolvedValue({ processed: 0, companies: 0, lastId: 0 });
  mocks.runDiscovery.mockResolvedValue(undefined);
  mocks.runLocationResolve.mockResolvedValue(LOCATION_RESULT);
  // Every tick logs its control gate; keep the output quiet.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("control registry ⇄ scrapers Worker", () => {
  it("declares exactly the three lanes this Worker runs", () => {
    expect(STAGE_IDS.filter((id) => stageDef(id).runtime === "cf:opusfinder-scrapers")).toEqual([
      "ingest",
      "discover",
      "locations",
    ]);
  });

  it("locations' cron is the one the Worker dispatches to the location run", async () => {
    await tick(stages.locations.trigger.cron, LOCATIONS_ON);
    expect(mocks.runLocationResolve).toHaveBeenCalledTimes(1);
    expect(mocks.runIngestion).not.toHaveBeenCalled();
    expect(mocks.runDiscovery).not.toHaveBeenCalled();
  });

  it("locations starts off in the registry and in the var wrangler.toml ships", () => {
    expect(stages.locations.initial).toBe("off");
    expect(/^LOCATIONS = "([^"]*)"$/m.exec(wranglerToml)?.[1]).toBe(stages.locations.initial);
  });

  it.each([
    ["off", {}, "skipped"],
    ["shadow", { LOCATIONS: "shadow" }, "ok"],
    ["on", LOCATIONS_ON, "ok"],
  ])(
    "a locations run under LOCATIONS=%s records a gate mode its stage has",
    async (mode, env, outcome) => {
      const recordRun = vi.fn(
        async (_run: Record<string, unknown>): Promise<unknown> => ({ id: 1 }),
      );
      const gate = async () => ({ mode, cappedBy: null, knobs: {}, by: null, because: null });
      await tick(stages.locations.trigger.cron, { ...env, CONTROL: { gate, recordRun } });
      expect(stages.locations.modes).toContain(mode);
      expect(recordRun.mock.calls.map(([run]) => run)).toMatchObject([
        { stage: "locations", outcome, gateMode: mode },
      ]);
    },
  );

  it("ingest's cron is the one the Worker dispatches to ingestion", async () => {
    await tick(stages.ingest.trigger.cron);
    expect(mocks.runIngestion).toHaveBeenCalledTimes(1);
    expect(mocks.runDiscovery).not.toHaveBeenCalled();
  });

  it("discover's cron is the one the Worker dispatches to discovery, budgeted at the knob defaults", async () => {
    await tick(stages.discover.trigger.cron);
    expect(mocks.runDiscovery).toHaveBeenCalledTimes(1);
    expect(mocks.runIngestion).not.toHaveBeenCalled();
    expect(argsOf(mocks.runDiscovery)).toMatchObject({
      limit: stages.discover.knobs.limit.default,
      reprobeLimit: stages.discover.knobs.reprobeLimit.default,
    });
  });

  it("boardsPerTick defaults to the Worker's fallback and to the value wrangler.toml ships", async () => {
    const knob = stages.ingest.knobs.boardsPerTick;
    expect(await ingestLimit()).toBe(knob.default);
    expect(new RegExp(`^${knob.legacyEnv} = "(\\d+)"$`, "m").exec(wranglerToml)?.[1]).toBe(
      String(knob.default),
    );
  });

  it("boardsPerTick's range is exactly what the Worker honours from that env var", async () => {
    const knob = stages.ingest.knobs.boardsPerTick;
    expect(await ingestLimit(String(knob.max))).toBe(knob.max);
    expect(await ingestLimit(String(knob.max + 1))).toBe(knob.max); // clamped to MAX_INGEST_LIMIT
    expect(await ingestLimit(String(knob.min))).toBe(knob.min);
    expect(await ingestLimit(String(knob.min - 1))).not.toBe(knob.min - 1); // rejected, falls back
  });

  it("each lane records exactly its stage's units, less the two this Worker can't measure", async () => {
    // cf.subrequests: there is no subrequest counter (the [limits] cap replaced it); neon.awake_s: an
    // estimate, left to the cost slice. Every other unit a scrapers stage declares must be sent.
    const notMeasuredHere = ["cf.subrequests", "neon.awake_s"];
    const recordRun = vi.fn(
      async (_run: { stage: StageId; units: Record<string, number> }): Promise<unknown> => ({
        id: 1,
      }),
    );
    const gate = async () => ({ mode: "on", cappedBy: null, knobs: {}, by: null, because: null });
    mocks.runIngestion.mockResolvedValue(INGEST_COUNTS);
    mocks.runDiscovery.mockResolvedValue(DISCOVERY_COUNTS);
    await tick(stages.ingest.trigger.cron, { CONTROL: { gate, recordRun } });
    await tick(stages.discover.trigger.cron, { CONTROL: { gate, recordRun } });
    await tick(stages.locations.trigger.cron, { ...LOCATIONS_ON, CONTROL: { gate, recordRun } });

    const runs = recordRun.mock.calls.map(([run]) => run);
    expect(runs.map((run) => run.stage)).toEqual(["ingest", "discover", "locations"]);
    for (const run of runs) {
      const declared: readonly string[] = stageDef(run.stage).units;
      expect(Object.keys(run.units).sort()).toEqual(
        declared.filter((unit) => !notMeasuredHere.includes(unit)).sort(),
      );
    }
  });

  it("the registry's defaults read as no drift against the vars wrangler.toml ships, on both lanes", async () => {
    // A renamed knob or policy (or a changed default on one side) shows up here as a drift line.
    const vars = Object.fromEntries(
      [...wranglerToml.matchAll(/^([A-Z][A-Z0-9_]*) = "([^"]*)"$/gm)].map((m) => [m[1], m[2]]),
    );
    const gate = async (stage: StageId) => ({
      ...gateView(new Map(), stage), // a store with no rows: every value is the registry default
      since: null,
      by: null,
      because: null,
    });
    const control = { gate, recordRun: async () => ({ id: 1 }) };
    mocks.runIngestion.mockResolvedValue(INGEST_COUNTS);
    mocks.runDiscovery.mockResolvedValue(DISCOVERY_COUNTS);
    await tick(stages.ingest.trigger.cron, { ...vars, CONTROL: control });
    await tick(stages.discover.trigger.cron, { ...vars, CONTROL: control });
    expect(console.log).toHaveBeenCalledWith("control gate ingest: on (shadow: not enforced)");
    expect(console.log).toHaveBeenCalledWith("control gate discover: on (shadow: not enforced)");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("labels its CONTROL binding with the registry's runtime id, so ledger rows name this runtime", () => {
    expect(/^props = \{ name = "([^"]+)" \}$/m.exec(wranglerToml)?.[1]).toBe(stages.ingest.runtime);
  });
});
