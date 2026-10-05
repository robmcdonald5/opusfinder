import { beforeEach, describe, expect, it, vi } from "vitest";

import { STAGE_IDS, stageDef, stages } from "@opusfinder/control";

// The control registry's scrapers stages copy this Worker's crons and ingest/discover sizing, but the pure
// registry can't import the Worker. The Worker can't export those constants for an import either: workerd
// rejects any named export of the main module that isn't a handler or class, so `export const INGEST_CRON`
// would fail the deploy. So this sync reads them through the Worker's REAL code path: the registry's cron
// must dispatch to its lane, and the ingest knob's env var must be honoured exactly inside its range.
// dispatch.test.ts separately pins wrangler.toml's crons to the same `case` labels.
// Pipelines are stubbed; no DB or network is touched.

const mocks = vi.hoisted(() => ({ runIngestion: vi.fn(), runDiscovery: vi.fn() }));

vi.mock("@opusfinder/db", () => ({ createDb: () => ({ __db: "stub" }) }));
vi.mock("@opusfinder/sources", () => ({ runIngestion: mocks.runIngestion }));
vi.mock("@opusfinder/discovery", () => ({ runDiscovery: mocks.runDiscovery }));

import wranglerToml from "../wrangler.toml?raw";
import worker from "./index";

const scheduled = worker.scheduled as unknown as (
  controller: { cron: string },
  env: Record<string, unknown>,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
) => Promise<void>;

async function tick(cron: string, env: Record<string, string> = {}): Promise<void> {
  const kv = { get: async () => null, put: async () => undefined };
  await scheduled(
    { cron },
    { DATABASE_URL: "postgres://stub", INGEST_CURSOR: kv, ...env },
    { waitUntil: () => {} },
  );
}

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
});

describe("control registry ⇄ scrapers Worker", () => {
  it("declares exactly the two lanes this Worker runs", () => {
    expect(STAGE_IDS.filter((id) => stageDef(id).runtime === "cf:opusfinder-scrapers")).toEqual([
      "ingest",
      "discover",
    ]);
  });

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
});
