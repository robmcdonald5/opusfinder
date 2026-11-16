import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import { runHealthCheck, runOrchestrator, runPerUser, type PerUserEvent } from "@opusfinder/digest";

import { closeEnforced, errorLine, recordRun, runRecord, type DigestWorkerStage } from "./control";
import {
  digestDeps,
  fanOutStore,
  healthDeps,
  type Env,
  type HealthParams,
  type RunParams,
} from "./env";
import { startUserRuns, type FanOutResult } from "./fan-out";
import { STEP_CONFIG, workflowStepTools, type WorkflowStepLike } from "./steps";

/**
 * The digest stages and the health check (@opusfinder/digest) on Cloudflare Workflows. The stage code is
 * the engine-free `runOrchestrator`, `runPerUser` and `runHealthCheck`; these classes hand it step tools
 * backed by the instance's `WorkflowStep` and nothing else. Step names are the stages' own ids, so an
 * instance that wakes from a sleep replays the finished steps from their stored results.
 */

function tools(step: WorkflowStep) {
  // The casts drop the SDK's serializable-result constraint: every stage step returns plain JSON.
  const like: WorkflowStepLike = {
    do: (name, config, callback) =>
      step.do(name, config, callback as () => Promise<never>) as ReturnType<typeof callback>,
    sleep: (name, durationMs) => step.sleep(name, durationMs),
  };
  // No custom name: the engine recognises its no-retry error by the name `NonRetryableError`.
  return workflowStepTools(like, (message) => new NonRetryableError(message));
}

/**
 * The run's ledger row, written as its last step. Best effort twice over: the write itself never throws and
 * gives up after the gate's timeout (./control), and a failure of the step around it is only logged. A
 * ledger problem must not turn a finished run into an errored one.
 */
function ledger<S extends DigestWorkerStage>(
  step: WorkflowStep,
  env: Env,
  stage: S,
  startedMs: number,
  gateMode: "shadow" | "on",
) {
  return async (outcome: "ok" | "error", detail: string): Promise<void> => {
    try {
      await step.do("record-run", STEP_CONFIG, () =>
        recordRun(env.CONTROL, (finishedMs) =>
          runRecord(stage, startedMs, finishedMs, { outcome, gateMode, detail }),
        ),
      );
    } catch (err) {
      console.warn(`control ledger: record-run step failed (${errorLine(err)})`);
    }
  };
}

/**
 * The orchestrator: one instance per daily tick (its id carries the tick's date, so a double cron fire
 * runs once). Opens the `digest_runs` row, sweeps the users who are due, starts their runs and closes the
 * row, then writes the tick's control-ledger row.
 */
export class DigestRunWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  override async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep) {
    const { run: stepRun } = tools(step);
    const deps = digestDeps(this.env);
    const { tick, mode, maxUsers } = event.payload;
    const record = ledger(step, this.env, "digest", event.timestamp.getTime(), mode);
    let fanOut: FanOutResult = { started: 0, inFlight: 0, alreadyStarted: 0, overLimit: 0 };
    try {
      const result = await runOrchestrator(
        deps,
        { data: { trigger: "cron" } },
        {
          run: stepRun,
          sendEvent: async (id, events) => {
            fanOut = await stepRun(id, () =>
              startUserRuns(fanOutStore(deps.db), this.env.DIGEST_USER, events, tick, maxUsers),
            );
          },
        },
      );
      await record(
        "ok",
        `${result.recipients} due · ${fanOut.started} started · ${fanOut.inFlight} still running · ` +
          `${fanOut.alreadyStarted} already started · ${fanOut.overLimit} over the per-tick limit`,
      );
      return { ...result, ...fanOut };
    } catch (err) {
      await record("error", errorLine(err));
      throw err;
    }
  }
}

/** One user's digest: load, retrieve, rerank, the synthesis batch and its waits, persist, the liveness
 *  probe and delivery. */
export class DigestUserWorkflow extends WorkflowEntrypoint<Env, PerUserEvent["data"]> {
  override async run(event: Readonly<WorkflowEvent<PerUserEvent["data"]>>, step: WorkflowStep) {
    // Read on every wake, outside a step: only the liveness step uses it, when that step runs.
    const deps = digestDeps(this.env, await closeEnforced(this.env.CONTROL));
    return runPerUser(deps, { data: event.payload }, tools(step));
  }
}

/**
 * The health check: one instance per 2-hourly tick (its id carries the tick's scheduled time, so a double
 * cron fire runs one check and sends at most one alert, where two would each read an empty cooldown before
 * either had written it). The check, its dedup, the alert and its record run as ONE step, as they did on
 * Inngest: a transient failure retries the whole unit, and a retry after a sent alert may send it once more
 * (the cooldown row is the dedup across runs).
 */
export class HealthCheckWorkflow extends WorkflowEntrypoint<Env, HealthParams> {
  override async run(event: Readonly<WorkflowEvent<HealthParams>>, step: WorkflowStep) {
    const record = ledger(step, this.env, "alerts", event.timestamp.getTime(), "on");
    try {
      const result = await tools(step).run("check-and-alert", () =>
        runHealthCheck(healthDeps(this.env, event.payload.vars)),
      );
      // Shape-only: check ids and counts.
      const detail =
        `${result.firing.length} firing · ${result.firingShadow.length} firing (logs only) · ` +
        `${result.notified.length} emailed · ${result.suppressed.length} in cooldown`;
      console.log(
        `health check: ${detail}` +
          (result.firing.length > 0 ? ` · firing: ${result.firing.join(", ")}` : "") +
          (result.firingShadow.length > 0 ? ` · logs only: ${result.firingShadow.join(", ")}` : ""),
      );
      await record("ok", detail);
      return result;
    } catch (err) {
      await record("error", errorLine(err));
      throw err;
    }
  }
}
