/**
 * The digest's parity record (test/digest/parity.ts), with the stages driven through this Worker's
 * Workflows step adapter: every step's output, seam call and row must equal what the stage code produced
 * on Inngest. The step under the adapter is a stand-in that runs each callback once; the real engine's
 * behaviour (retries, sleeps, stored errors) is engine.integration.test.ts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "@opusfinder/db";
import {
  NonRetriableError,
  runOrchestrator,
  runPerUser,
  type DigestDeps,
} from "@opusfinder/digest";
import { BatchEndedError } from "@opusfinder/llm";

import { createTestDb } from "@test/db/pglite";
import { recordParity, type ParityScenario } from "@test/digest/parity";

import { STEP_CONFIG, workflowStepTools, type StepConfig } from "./steps";

const FIXTURE = fileURLToPath(new URL("../../../test/digest/parity.fixture.json", import.meta.url));

/** The engine's no-retry error, as `cloudflare:workflows` names it. */
class NonRetryableError extends Error {
  override name = "NonRetryableError";
}

/** A wait as the stage code wrote it ("30s", "2m"), from the milliseconds the adapter hands the engine. */
const stageDuration = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000}m` : `${ms / 1_000}s`);

describe("digest stages on the Workflows step adapter — parity record", () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await close?.();
  });

  it("every step output, seam call and row matches the record made on Inngest", async () => {
    const engineSteps: { name: string; config: StepConfig }[] = [];
    const record = await recordParity<DigestDeps>(db, {
      buildDeps: (seams) => seams,
      runOrchestrator,
      runPerUser,
      batchFailed: (batchId) => new BatchEndedError(batchId, "failed", "provider error"),
      isNonRetriable: (err) => err instanceof NonRetryableError || err instanceof NonRetriableError,
      wrapStep: (recorder) => {
        const tools = workflowStepTools(
          {
            do: (name, config, callback) => {
              engineSteps.push({ name, config });
              return callback();
            },
            sleep: (name, durationMs) => recorder.sleep(name, stageDuration(durationMs)),
          },
          (message) => new NonRetryableError(message),
        );
        return {
          // The recorder sits inside the engine step, where the stage's own result and error are.
          run: (id, fn) => tools.run(id, () => recorder.run(id, fn)),
          sleep: tools.sleep,
          sendEvent: recorder.sendEvent,
        };
      },
    });

    const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as ParityScenario[];
    expect(record.map((s) => s.name)).toEqual(expected.map((s) => s.name));
    for (const [i, scenario] of record.entries()) {
      const want = expected[i]!;
      expect(scenario.log, scenario.name).toEqual(want.log);
      expect(scenario.rows, scenario.name).toEqual(want.rows);
      expect(scenario.outcome, scenario.name).toEqual(throughEngine(want));
    }

    // Every stage step ran as an engine step under the one retry policy, named by its stage id.
    const stageSteps = record.flatMap((s) =>
      s.log.flatMap((entry) => ("step" in entry ? [entry.step] : [])),
    );
    expect(engineSteps.map((s) => s.name)).toEqual(stageSteps);
    expect(engineSteps.every((s) => s.config === STEP_CONFIG)).toBe(true);
  }, 60_000);
});

/**
 * The recorded outcome as it reads on this engine. One difference: a no-retry error thrown INSIDE a step
 * reaches the run as the engine's `NonRetryableError` (same message, still not retried); one thrown
 * between steps is the stage's own.
 */
function throughEngine(want: ParityScenario): ParityScenario["outcome"] {
  if (!("threw" in want.outcome) || !want.outcome.threw.nonRetriable) return want.outcome;
  const last = want.log.at(-1);
  const insideStep =
    last !== undefined && "threw" in last && last.threw.message === want.outcome.threw.message;
  // The orchestrator's failure path runs one more step (fail-run) after the step that threw.
  const beforeFailRun = want.log.at(-2);
  const failRun =
    last !== undefined &&
    "step" in last &&
    last.step === "fail-run" &&
    beforeFailRun !== undefined &&
    "threw" in beforeFailRun;
  return insideStep || failRun
    ? { threw: { ...want.outcome.threw, name: "NonRetryableError" } }
    : want.outcome;
}
