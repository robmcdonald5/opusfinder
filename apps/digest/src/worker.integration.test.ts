/**
 * The REAL digest Worker bundle in workerd (Miniflare), with its compatibility date and no compatibility
 * flags, a fake control Worker behind CONTROL and every outbound fetch refused: it loads, each cron in
 * wrangler.toml dispatches, and nothing runs (no Workflow instance, no database or provider call) unless
 * the control plane says the stage is on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { gateView, stages, type StageId } from "@opusfinder/control";

import { startDigestWorker, wranglerToml, type DigestWorker } from "@test/digest/worker-harness";

import { orchestratorRunId } from "./fan-out";

const [DIGEST_CRON, HEALTH_CRON] = [
  ...(/crons = \[([^\]]*)\]/.exec(wranglerToml())?.[1] ?? "").matchAll(/"([^"]+)"/g),
].map((m) => m[1]!) as [string, string];
const TICK = "2026-11-16";
/** The health check's instance for the harness's default scheduled time (2026-11-16 12:10 UTC). */
const HEALTH_CHECK_ID = "health-check_2026-11-16T12-10";

/** The gates the control plane would answer with these stored rows (none = registry defaults: all off). */
function gates(rows: Record<string, string> = {}) {
  const answer = (stage: StageId) => ({
    ...gateView(new Map(Object.entries(rows)), stage),
    since: null,
    by: null,
    because: null,
  });
  return { digest: answer("digest"), alerts: answer("alerts") };
}

/** Where neon-http sends the queries of the harness's DATABASE_URL (host db.neon.test). */
const NEON_HOST = "api.neon.test";
const outboundHosts = (worker: DigestWorker) => [
  ...new Set(worker.outbound.map((url) => new URL(url).host)),
];

/** Poll until `read` is truthy (the Workflow runs in the background of the tick that started it). */
async function eventually<T>(read: () => T | Promise<T>): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met in time");
}

describe("the digest Worker bundle in workerd", () => {
  let worker: DigestWorker;
  beforeAll(async () => {
    worker = await startDigestWorker();
  }, 120_000);
  afterAll(async () => {
    await worker?.dispose();
  });
  beforeEach(async () => {
    await worker.ledger();
    worker.outbound.length = 0;
  });

  it("deploys the two crons the registry declares", () => {
    expect(DIGEST_CRON).toBe(stages.digest.trigger.cron);
    expect(HEALTH_CRON).toBe(stages.alerts.trigger.cron);
  });

  it("off: both ticks do nothing but record that they were skipped", async () => {
    await worker.setGates(gates());

    expect(await worker.fire(DIGEST_CRON)).toBe(true);
    expect(await worker.fire(HEALTH_CRON)).toBe(true);

    expect(await worker.ledger()).toEqual([
      expect.objectContaining({
        stage: "digest",
        outcome: "skipped",
        gateMode: "off",
        detail: "off",
        by: stages.digest.runtime,
      }),
      expect.objectContaining({ stage: "alerts", outcome: "skipped", gateMode: "off" }),
    ]);
    expect((await worker.instance("DIGEST_RUN", orchestratorRunId(TICK))).found).toBe(false);
    expect((await worker.instance("HEALTH_CHECK", HEALTH_CHECK_ID)).found).toBe(false);
    expect(worker.outbound).toEqual([]);
  });

  it("an unreadable control plane is off too", async () => {
    await worker.setGates({});

    expect(await worker.fire(DIGEST_CRON)).toBe(true);
    expect(await worker.fire(HEALTH_CRON)).toBe(true);

    expect(await worker.ledger()).toEqual([
      expect.objectContaining({ stage: "digest", outcome: "error", detail: "gate unreadable" }),
      expect.objectContaining({ stage: "alerts", outcome: "error", detail: "gate unreadable" }),
    ]);
    expect((await worker.instance("DIGEST_RUN", orchestratorRunId(TICK))).found).toBe(false);
    expect((await worker.instance("HEALTH_CHECK", HEALTH_CHECK_ID)).found).toBe(false);
    expect(worker.outbound).toEqual([]);
  });

  it("the master switch off stops a stage that is on", async () => {
    await worker.setGates(gates({ digest: "on", alerts: "on", global: "off" }));

    await worker.fire(DIGEST_CRON);
    await worker.fire(HEALTH_CRON);

    expect((await worker.ledger()).map((row) => row.outcome)).toEqual(["skipped", "skipped"]);
    expect(worker.outbound).toEqual([]);
  });

  it("an unknown cron is an errored invocation, not a silent no-op", async () => {
    await worker.setGates(gates({ digest: "on" }));
    expect(await worker.fire("0 0 * * *")).toBe(false);
    expect(worker.outbound).toEqual([]);
  });

  it("alerts on: the tick starts the health check once, however often it fires", async () => {
    await worker.setGates(gates({ alerts: "on" }));

    expect(await worker.fire(HEALTH_CRON)).toBe(true);
    expect(await worker.fire(HEALTH_CRON)).toBe(true);

    // One instance, under the tick's scheduled minute. Its first query reaches for Neon and nothing else.
    expect((await worker.instance("HEALTH_CHECK", HEALTH_CHECK_ID)).found).toBe(true);
    await eventually(() => worker.outbound.length > 0);
    expect(outboundHosts(worker)).toEqual([NEON_HOST]);
    // The tick wrote no row of its own: the check writes it when it ends.
    expect(await worker.ledger()).toEqual([]);
  });

  it("digest in logs-only mode: the tick starts the orchestrator once, however often it fires", async () => {
    await worker.setGates(gates({ digest: "shadow" }));

    expect(await worker.fire(DIGEST_CRON)).toBe(true);
    expect(await worker.fire(DIGEST_CRON)).toBe(true);

    expect((await worker.instance("DIGEST_RUN", orchestratorRunId(TICK))).found).toBe(true);
    // The orchestrator's first step opens the digest_runs row: the only thing it reaches for is Neon.
    await eventually(() => worker.outbound.length > 0);
    expect(outboundHosts(worker)).toEqual([NEON_HOST]);
    // No per-user run was started (the sweep never got its answer).
    expect(await worker.ledger()).toEqual([]);
  });
});
