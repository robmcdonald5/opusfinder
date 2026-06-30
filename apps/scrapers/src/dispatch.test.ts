import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase-1 leaf pure-unit for the scrapers Worker dispatch + cursor state machine (scheduled() →
// runIngestionTick). The load-bearing behavior: (1) `controller.cron` routes to exactly one lane and
// an UNHANDLED cron THROWS (a silent no-op would hide a wrangler.toml/constant drift), (2) the KV
// chunk cursor parse/clamp/wrap math never stalls the cron — a corrupt cursor restarts at 0, a
// misconfigured limit clamps into [1, MAX], and the cursor only WRAPS to 0 on a fully-processed
// under-filled chunk (else it advances, never skipping a budget-truncated chunk), and (3) a tick
// failure is logged + re-thrown so Cloudflare records the invocation as errored. createDb/runIngestion/
// runDiscovery are stubbed so NO DB or network is touched — we assert routing + cursor math purely via
// the args handed to those fakes and the value written back to KV.

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  runIngestion: vi.fn(),
  runDiscovery: vi.fn(),
}));

vi.mock("@opusfinder/db", () => ({ createDb: mocks.createDb }));
vi.mock("@opusfinder/sources", () => ({ runIngestion: mocks.runIngestion }));
vi.mock("@opusfinder/discovery", () => ({ runDiscovery: mocks.runDiscovery }));
vi.mock("@opusfinder/shared", () => ({
  // Mirror the real flag semantics narrowly (only the explicit "enforce" affirmative enables) so we can
  // assert the env var is threaded into the pipeline opts without pulling the real package.
  parseEnforceFlag: (value?: string) => value === "enforce",
}));

import worker, { pingWatchdogFail } from "./index";

// Mirrors the wrangler.toml / src/index.ts cron constants — must match character-for-character (esp.
// the weekday "SUN", not "0"); a mismatch here is exactly the drift the default-case throw guards.
const INGEST_CRON = "0 * * * *";
const DISCOVERY_CRON = "0 3 * * SUN";

// Production constants the cursor/limit math is pinned against (src/index.ts).
const DEFAULT_INGEST_LIMIT = 150;
const MAX_INGEST_LIMIT = 500;
const MAX_JOBS_PER_BOARD = 1500;
const MAX_RUN_MS = 10 * 60_000;

// Sentinel returned by createDb — asserts the SAME client instance is threaded into the pipeline.
const DB = { __db: "sentinel" } as const;

const scheduled = worker.scheduled as unknown as (
  controller: { cron: string },
  env: Record<string, unknown>,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
) => Promise<void>;

function makeCtx() {
  return { waitUntil: vi.fn() };
}

function makeKv(cursorRaw: string | null) {
  return {
    // Typed with the real KV arg shapes so `.mock.calls[n]` indexes the captured (key, value) args.
    get: vi.fn(async (_key: string) => cursorRaw),
    put: vi.fn(async (_key: string, _value: string) => undefined),
  };
}

interface Counts {
  processed: number;
  companies: number;
  lastId: number;
}

/** Drive one ingestion tick and surface the opts handed to runIngestion + the cursor written to KV. */
async function runIngestTick(opts: {
  cursorRaw?: string | null;
  env?: Record<string, unknown>;
  counts?: Counts;
}) {
  const counts = opts.counts ?? { processed: 0, companies: 0, lastId: 0 };
  mocks.runIngestion.mockResolvedValue(counts);
  const kv = makeKv(opts.cursorRaw ?? null);
  const ctx = makeCtx();
  const env = { DATABASE_URL: "postgres://stub", INGEST_CURSOR: kv, ...opts.env };
  await scheduled({ cron: INGEST_CRON }, env, ctx);
  const ingestArgs = mocks.runIngestion.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
  const cursorWritten = kv.put.mock.calls.at(-1)?.[1] as string | undefined;
  return { ingestArgs, cursorWritten, kv, ctx };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.createDb.mockReturnValue(DB);
});

describe("scheduled() dispatch", () => {
  it("throws a clear error when DATABASE_URL is unset, before building the client or running a pipeline", async () => {
    await expect(
      scheduled({ cron: INGEST_CRON }, { INGEST_CURSOR: makeKv(null) }, makeCtx()),
    ).rejects.toThrow(/DATABASE_URL is not set/);
    expect(mocks.createDb).not.toHaveBeenCalled();
    expect(mocks.runIngestion).not.toHaveBeenCalled();
  });

  it("builds the neon client from env.DATABASE_URL and routes the ingest cron to runIngestion only", async () => {
    await runIngestTick({});
    expect(mocks.createDb).toHaveBeenCalledWith("postgres://stub");
    expect(mocks.runIngestion).toHaveBeenCalledTimes(1);
    expect(mocks.runIngestion.mock.calls[0]![0]).toBe(DB);
    expect(mocks.runDiscovery).not.toHaveBeenCalled();
  });

  it("routes the discovery cron to runDiscovery with the worker-safe budget, never runIngestion", async () => {
    mocks.runDiscovery.mockResolvedValue(undefined);
    await scheduled(
      { cron: DISCOVERY_CRON },
      { DATABASE_URL: "postgres://stub", INGEST_CURSOR: makeKv(null) },
      makeCtx(),
    );
    expect(mocks.runDiscovery).toHaveBeenCalledTimes(1);
    expect(mocks.runDiscovery.mock.calls[0]![0]).toBe(DB);
    expect(mocks.runDiscovery.mock.calls[0]![1]).toEqual({
      limit: 400,
      reprobeLimit: 500,
      workerOnly: true,
      enforceLifecycle: false,
    });
    expect(mocks.runIngestion).not.toHaveBeenCalled();
  });

  it("threads the lifecycle-enforce flag into discovery when LIFECYCLE_CLOSE_ENFORCE=enforce", async () => {
    mocks.runDiscovery.mockResolvedValue(undefined);
    await scheduled(
      { cron: DISCOVERY_CRON },
      {
        DATABASE_URL: "postgres://stub",
        INGEST_CURSOR: makeKv(null),
        LIFECYCLE_CLOSE_ENFORCE: "enforce",
      },
      makeCtx(),
    );
    expect(mocks.runDiscovery.mock.calls[0]![1]).toMatchObject({ enforceLifecycle: true });
  });

  it("throws Unhandled cron on a cron string no case matches (drift surfaces as a FAILED invocation)", async () => {
    await expect(
      scheduled(
        { cron: "0 0 * * *" },
        { DATABASE_URL: "postgres://stub", INGEST_CURSOR: makeKv(null) },
        makeCtx(),
      ),
    ).rejects.toThrow(/Unhandled cron "0 0 \* \* \*"/);
    expect(mocks.runIngestion).not.toHaveBeenCalled();
    expect(mocks.runDiscovery).not.toHaveBeenCalled();
  });

  it("logs and re-throws a tick failure, and skips the success heartbeat", async () => {
    const error = new Error("kv exploded");
    mocks.runIngestion.mockRejectedValueOnce(error);
    const fetchSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchSpy);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      scheduled(
        { cron: INGEST_CRON },
        { DATABASE_URL: "postgres://stub", INGEST_CURSOR: makeKv(null) },
        makeCtx(),
      ),
    ).rejects.toBe(error);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("scheduled(0 * * * *) failed: Error: kv exploded"),
    );
    // HEALTH_PING_URL unset ⇒ neither the heartbeat nor the fail ping touches the network.
    expect(fetchSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("fires the failure ping (not the heartbeat) on a caught tick exception when HEALTH_PING_URL is set", async () => {
    mocks.runIngestion.mockRejectedValueOnce(new Error("boom"));
    const fetchSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchSpy);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      scheduled(
        { cron: INGEST_CRON },
        {
          DATABASE_URL: "postgres://stub",
          INGEST_CURSOR: makeKv(null),
          HEALTH_PING_URL: "https://hc.example/abc",
        },
        makeCtx(),
      ),
    ).rejects.toThrow(/boom/);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe("https://hc.example/abc/fail");
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ method: "POST" });
    consoleSpy.mockRestore();
  });

  it("sends the content-free heartbeat (no /fail) after a successful ingest tick when HEALTH_PING_URL is set", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchSpy);
    await runIngestTick({ env: { HEALTH_PING_URL: "https://hc.example/abc" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("https://hc.example/abc");
  });

  it("does NOT heartbeat on the weekly discovery lane (the watchdog is calibrated to the hourly ingest cadence)", async () => {
    mocks.runDiscovery.mockResolvedValue(undefined);
    const fetchSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchSpy);
    await scheduled(
      { cron: DISCOVERY_CRON },
      {
        DATABASE_URL: "postgres://stub",
        INGEST_CURSOR: makeKv(null),
        HEALTH_PING_URL: "https://hc.example/abc",
      },
      makeCtx(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("runIngestionTick — fixed pipeline budget", () => {
  it("passes the per-board / per-run safety caps unchanged on every tick", async () => {
    const { ingestArgs } = await runIngestTick({});
    expect(ingestArgs).toMatchObject({
      activeOnly: true,
      maxRunMs: MAX_RUN_MS,
      adapter: { maxItems: MAX_JOBS_PER_BOARD },
    });
  });

  it("threads both enforce switches independently (LIFECYCLE_CLOSE_ENFORCE vs STALE_SWEEP)", async () => {
    const { ingestArgs } = await runIngestTick({
      env: { LIFECYCLE_CLOSE_ENFORCE: "enforce", STALE_SWEEP: "shadow" },
    });
    expect(ingestArgs).toMatchObject({
      enforceLifecycle: true,
      staleSweep: expect.objectContaining({ enforce: false }),
    });
  });

  it("defaults both enforce switches to false (count-only) when unset", async () => {
    const { ingestArgs } = await runIngestTick({});
    expect(ingestArgs?.enforceLifecycle).toBe(false);
    expect(ingestArgs?.staleSweep).toMatchObject({ enforce: false });
  });
});

describe("runIngestionTick — cursor parse (corrupt cursor restarts at afterId 0, never stalls on NaN)", () => {
  it.each<[string | null, number]>([
    [null, 0],
    ["0", 0],
    ["123", 123],
    ["-5", 0],
    ["abc", 0],
    ["12.7", 12],
    ["  42  ", 42],
  ])("cursor %j → afterId %d", async (cursorRaw, expected) => {
    const { ingestArgs } = await runIngestTick({ cursorRaw });
    expect(ingestArgs?.afterId).toBe(expected);
  });
});

describe("runIngestionTick — limit parse/clamp (a misconfigured INGEST_LIMIT can't stall or blow budget)", () => {
  it.each<[string | undefined, number]>([
    [undefined, DEFAULT_INGEST_LIMIT],
    ["200", 200],
    ["50000", MAX_INGEST_LIMIT],
    ["500", MAX_INGEST_LIMIT],
    ["0", DEFAULT_INGEST_LIMIT],
    ["-3", DEFAULT_INGEST_LIMIT],
    ["abc", DEFAULT_INGEST_LIMIT],
    ["75.9", 75],
  ])("INGEST_LIMIT %j → limit %d", async (value, expected) => {
    const env = value === undefined ? {} : { INGEST_LIMIT: value };
    const { ingestArgs } = await runIngestTick({ env });
    expect(ingestArgs?.limit).toBe(expected);
  });
});

describe("runIngestionTick — stale-sweep TTL parse (falls back to the sweep default, never a 0/NaN horizon)", () => {
  it.each<[string | undefined, number | undefined]>([
    [undefined, undefined],
    ["30", 30],
    ["0", undefined],
    ["-1", undefined],
    ["abc", undefined],
    ["21.8", 21],
  ])("STALE_SWEEP_TTL_DAYS %j → ttlDays %j", async (value, expected) => {
    const env = value === undefined ? {} : { STALE_SWEEP_TTL_DAYS: value };
    const { ingestArgs } = await runIngestTick({ env });
    const staleSweep = ingestArgs?.staleSweep as { ttlDays?: number } | undefined;
    expect(staleSweep?.ttlDays).toBe(expected);
  });
});

describe("runIngestionTick — cursor wrap math (wrap to 0 only at end of table, else advance)", () => {
  it("wraps to 0 when the whole chunk processed AND under-filled (end of table reached)", async () => {
    const { cursorWritten } = await runIngestTick({
      counts: { processed: 90, companies: 90, lastId: 555 },
    });
    expect(cursorWritten).toBe("0");
  });

  it("advances to lastId when the run budget truncated the chunk (processed < companies)", async () => {
    const { cursorWritten } = await runIngestTick({
      counts: { processed: 40, companies: 90, lastId: 777 },
    });
    expect(cursorWritten).toBe("777");
  });

  it("advances to lastId on a full chunk (companies == limit) — more boards may remain, so never wrap", async () => {
    const { cursorWritten } = await runIngestTick({
      counts: { processed: DEFAULT_INGEST_LIMIT, companies: DEFAULT_INGEST_LIMIT, lastId: 888 },
    });
    expect(cursorWritten).toBe("888");
  });

  it("reads and writes the cursor under the SAME 'afterId' KV key (a key drift would reset the sweep every tick)", async () => {
    const { kv } = await runIngestTick({ cursorRaw: "123", counts: { processed: 1, companies: 1, lastId: 200 } });
    expect(kv.get).toHaveBeenCalledWith("afterId");
    expect(kv.put.mock.calls[0]![0]).toBe("afterId");
  });
});

// pingWatchdogFail is exported solely for this smoke: the published /fail body must be the FIRST LINE
// only, capped at 500 chars, so a multi-line drizzle error never leaks bound params / a connection
// string to the external watchdog.
describe("pingWatchdogFail", () => {
  it("skips the network entirely when HEALTH_PING_URL is unset", () => {
    const fetchSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchSpy);
    const ctx = makeCtx();
    pingWatchdogFail({} as never, ctx as never, "anything");
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs the single-line message to ${HEALTH_PING_URL}/fail and bounds it via waitUntil", () => {
    const fetchSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchSpy);
    const ctx = makeCtx();
    pingWatchdogFail({ HEALTH_PING_URL: "https://hc.example/x" } as never, ctx as never, "down hard");
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("https://hc.example/x/fail", {
      method: "POST",
      body: "down hard",
    });
  });

  it("publishes only the first line of a multi-line message (drops the drizzle params: tail)", () => {
    const fetchSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchSpy);
    pingWatchdogFail(
      { HEALTH_PING_URL: "https://hc.example/x" } as never,
      makeCtx() as never,
      "Failed query: select ...\nparams: [secret, 42]",
    );
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ body: "Failed query: select ..." });
  });

  it("caps the published body at 500 chars", () => {
    const fetchSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchSpy);
    pingWatchdogFail(
      { HEALTH_PING_URL: "https://hc.example/x" } as never,
      makeCtx() as never,
      "z".repeat(900),
    );
    const body = (fetchSpy.mock.calls[0]![1] as { body: string }).body;
    expect(body).toHaveLength(500);
  });
});
