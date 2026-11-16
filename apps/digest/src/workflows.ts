import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import { runOrchestrator, runPerUser, type PerUserEvent } from "@opusfinder/digest";

import { closeEnforced, errorLine, recordRun, runRecord } from "./control";
import { digestDeps, instanceStore, type Env, type RunParams } from "./env";
import { startUserRuns, type FanOutResult } from "./fan-out";
import { STEP_CONFIG, workflowStepTools, type WorkflowStepLike } from "./steps";

/**
 * The digest stages (@opusfinder/digest) on Cloudflare Workflows. The stage code is the engine-free
 * `runOrchestrator` and `runPerUser`; these classes hand it step tools backed by the instance's
 * `WorkflowStep` and nothing else. Step names are the stages' own ids, so an instance that wakes from a
 * sleep replays the finished steps from their stored results.
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
 * The orchestrator: one instance per daily tick (its id carries the tick's date, so a double cron fire
 * runs once). Opens the `digest_runs` row, sweeps the users who are due, starts their runs and closes the
 * row, then writes the tick's control-ledger row.
 */
export class DigestRunWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  override async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep) {
    const { run: stepRun } = tools(step);
    const deps = digestDeps(this.env);
    const { tick, mode: gateMode, maxUsers } = event.payload;
    const startedMs = event.timestamp.getTime();
    let fanOut: FanOutResult = { started: 0, inFlight: 0, alreadyStarted: 0, overLimit: 0 };
    // The ledger write never throws (./control), so this step can't fail the run.
    const record = (outcome: "ok" | "error", detail: string) =>
      step.do("record-run", STEP_CONFIG, () =>
        recordRun(this.env.CONTROL, (finishedMs) =>
          runRecord("digest", startedMs, finishedMs, { outcome, gateMode, detail }),
        ),
      );
    try {
      const result = await runOrchestrator(
        deps,
        { data: { trigger: "cron" } },
        {
          run: stepRun,
          sendEvent: async (id, events) => {
            fanOut = await stepRun(id, () =>
              startUserRuns(instanceStore(deps.db), this.env.DIGEST_USER, events, tick, maxUsers),
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
