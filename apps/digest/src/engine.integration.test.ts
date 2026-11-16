/**
 * The rules that depend on the Workflows engine, on Miniflare's local one: the real fan-out
 * (src/fan-out.ts) and the real step adapter (src/steps.ts) inside a Workflow, driving a scripted stage
 * (test/digest/worker-harness.ts). Retry waits are shortened; their count is production's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startEngineWorker, type EngineWorker } from "@test/digest/worker-harness";

import { userRunId } from "./fan-out";
import { RECORD_SENT_CONFIG, STEP_CONFIG } from "./steps";

const MON = "2026-11-16";
const TUE = "2026-11-17";
const WED = "2026-11-18";
const THU = "2026-11-19";

describe("the digest's Workflows rules on the local engine", () => {
  let engine: EngineWorker;
  beforeAll(async () => {
    engine = await startEngineWorker();
  }, 60_000);
  afterAll(async () => {
    await engine?.dispose();
  });

  it("a second start for the same user and tick starts nothing: the run's body runs once", async () => {
    const user = "user-second-start";
    expect(await engine.fanOut([user], MON)).toMatchObject({ started: 1, alreadyStarted: 0 });
    expect(await engine.fanOut([user], MON)).toMatchObject({ started: 0, alreadyStarted: 1 });
    // And asking the engine directly for the same id doesn't run it again either. (Production refuses
    // the id outright; this local engine hands back the first instance.)
    await engine.create(userRunId(user, MON), user);

    expect((await engine.finished(userRunId(user, MON))).status).toBe("complete");
    expect((await engine.attempts())[`${user}:load`]).toBe(1);
  }, 30_000);

  it("a run that spans two ticks keeps its user out of both, and the tick after it ends starts the next", async () => {
    const user = "user-long-run";
    await engine.script(user, { sleep: "3s" });
    expect(await engine.fanOut([user], MON)).toMatchObject({ started: 1 });

    expect(await engine.fanOut([user], TUE)).toMatchObject({ started: 0, inFlight: 1 });
    expect(await engine.fanOut([user], WED)).toMatchObject({ started: 0, inFlight: 1 });
    expect(await engine.status(userRunId(user, TUE))).toBeNull();
    expect(await engine.status(userRunId(user, WED))).toBeNull();

    expect((await engine.finished(userRunId(user, MON))).status).toBe("complete");
    expect(await engine.fanOut([user], THU)).toMatchObject({ started: 1, inFlight: 0 });
    expect((await engine.finished(userRunId(user, THU))).status).toBe("complete");
    expect((await engine.attempts())[`${user}:load`]).toBe(2);
  }, 30_000);

  it("the stages' no-retry error fails the run on its first attempt", async () => {
    const user = "user-no-retry";
    await engine.script(user, { fail: "no-retry" });
    await engine.fanOut([user], MON);

    // The engine's own message for it: the stage's reason is in the Worker's log (steps.test.ts).
    const ended = await engine.finished(userRunId(user, MON));
    expect(ended.status).toBe("errored");
    expect(ended.error?.message).toContain("NonRetryableError");
    expect((await engine.attempts())[`${user}:work`]).toBe(1);
  }, 30_000);

  it("any other error is retried four times, then fails the run; the next tick starts a fresh one", async () => {
    const user = "user-retried";
    await engine.script(user, { fail: "plain" });
    await engine.fanOut([user], MON);

    expect((await engine.finished(userRunId(user, MON))).status).toBe("errored");
    expect((await engine.attempts())[`${user}:work`]).toBe(STEP_CONFIG.retries.limit + 1);

    // A failed run stamps nothing, so its user is due again at the next tick, under the next id.
    await engine.script(user, {});
    expect(await engine.fanOut([user], TUE)).toMatchObject({ started: 1, inFlight: 0 });
    expect((await engine.finished(userRunId(user, TUE))).status).toBe("complete");
  }, 30_000);

  it("a failed query's parameters never reach the instance's stored error", async () => {
    const user = "user-failed-query";
    await engine.script(user, { fail: "query" });
    await engine.fanOut([user], MON);

    const ended = await engine.finished(userRunId(user, MON));
    expect(ended.status).toBe("errored");
    expect(ended.error?.message).toContain(
      "canceling statement due to statement timeout | Failed query: select 1",
    );
    expect(JSON.stringify(ended)).not.toContain("someone@example.com");
    expect(JSON.stringify(ended)).not.toContain("params");
  }, 30_000);

  it("an email that went out is recorded even when the write fails far past the usual retries", async () => {
    const user = "user-record-sent";
    // Twelve failures: three times what any other step survives (STEP_CONFIG's 4 retries would have
    // ended the run with the email out and nothing stamped, and the next tick would send a second).
    const failures = 3 * STEP_CONFIG.retries.limit;
    expect(failures).toBeLessThan(RECORD_SENT_CONFIG.retries.limit);
    await engine.script(user, { recordSentFails: failures });
    await engine.fanOut([user], MON);

    expect((await engine.finished(userRunId(user, MON))).status).toBe("complete");
    const attempts = await engine.attempts();
    expect(attempts[`${user}:record-sent`]).toBe(failures + 1);
    expect(attempts[`${user}:send-email`]).toBe(1); // the send step is not run again
    // While the write was still failing the run was unfinished, so a later tick would have skipped the
    // user; now that it has ended, the next tick finds nothing in flight.
    expect(await engine.fanOut([user], TUE)).toMatchObject({ started: 1, inFlight: 0 });
  }, 30_000);
});
