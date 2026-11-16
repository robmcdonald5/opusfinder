import { DIGEST_CADENCE_CRON, HEALTH_CHECK_CRON } from "@opusfinder/digest";

import {
  errorLine,
  healthVars,
  maxUsersPerTick,
  recordRun,
  runRecord,
  tickGate,
  type DigestWorkerStage,
} from "./control";
import type { Env } from "./env";
import { orchestratorRunId, tickDate } from "./fan-out";

export { DigestRunWorkflow, DigestUserWorkflow, HealthCheckWorkflow } from "./workflows";

/**
 * The opusfinder digest Worker: two scheduled (cron) handlers, dispatched on `controller.cron`. Each reads
 * its stage's gate and, if the stage is on, starts one Workflow instance (./workflows) and returns:
 *  - the daily digest tick starts the orchestrator, which starts one Workflow run per user who is due;
 *  - the 2-hourly tick starts the health check.
 * Both ride the scrapers Worker's ingestion ticks (10 min after one starts), so their Neon reads land
 * while Neon is already awake.
 *
 * An instance's id carries its tick (the date, or the scheduled minute), so a tick that fires twice runs
 * its work once: production refuses a used id, and the local engine hands back the first instance.
 *
 * The control plane's gate is the ONLY switch for both stages (./control.ts): off or unreadable means the
 * tick does nothing but write its ledger row. Its own DB role (`digest_worker`) and secrets: the scrapers
 * Worker has no access to user tables or email, and this one has none to ingestion's writes beyond the
 * 410 close.
 *
 * The cron strings MUST match wrangler.toml [triggers].crons character for character
 * (worker.integration.test.ts reads that array), and an unknown one throws, so a stale trigger is an
 * errored invocation, not a silent no-op.
 */

/** The health check's instance id: its tick's scheduled time to the minute (`health-check_2026-11-16T12-10`). */
function healthCheckId(scheduledTimeMs: number): string {
  return `health-check_${new Date(scheduledTimeMs).toISOString().slice(0, 16).replace(":", "-")}`;
}

/**
 * Start the tick's instance, unless this tick already did. A refused start for an id that exists is the
 * second fire of one tick; any other failure is thrown.
 */
async function startOnce<P>(workflow: Workflow<P>, id: string, params: P): Promise<boolean> {
  try {
    await workflow.create({ id, params });
    return true;
  } catch (err) {
    try {
      await workflow.get(id);
    } catch {
      throw err;
    }
    return false;
  }
}

/** The tick's own ledger row: written only when the tick starts nothing (off, unreadable, a failed start).
 *  A started instance writes the row when it ends. */
function tickRow(env: Env, stage: DigestWorkerStage, startedMs: number, mode: string | null) {
  return (outcome: "error" | "skipped", detail: string) =>
    recordRun(env.CONTROL, (finishedMs) =>
      runRecord(stage, startedMs, finishedMs, {
        outcome,
        gateMode: mode as "off" | "shadow" | "on" | null,
        detail,
      }),
    );
}

async function digestTick(env: Env, scheduledTimeMs: number): Promise<void> {
  const tick = tickDate(scheduledTimeMs);
  const gate = await tickGate(env.CONTROL, "digest");
  const row = tickRow(env, "digest", Date.now(), gate?.mode ?? null);
  if (gate === null) return row("error", "gate unreadable");
  if (gate.mode === "off") return row("skipped", "off");
  const id = orchestratorRunId(tick);
  try {
    const started = await startOnce(env.DIGEST_RUN, id, {
      tick,
      mode: gate.mode,
      maxUsers: maxUsersPerTick(gate),
    });
    console.log(
      `digest tick ${tick}: ${id} ${started ? `started (${gate.mode})` : "was already started"}`,
    );
  } catch (err) {
    await row("error", `run not started: ${errorLine(err)}`);
    throw err;
  }
}

async function healthTick(env: Env, scheduledTimeMs: number): Promise<void> {
  const gate = await tickGate(env.CONTROL, "alerts");
  const row = tickRow(env, "alerts", Date.now(), gate?.mode ?? null);
  if (gate === null) return row("error", "gate unreadable");
  if (gate.mode === "off") return row("skipped", "off");
  const id = healthCheckId(scheduledTimeMs);
  try {
    const started = await startOnce(env.HEALTH_CHECK, id, { vars: healthVars(gate) });
    console.log(`health tick: ${id} ${started ? "started" : "was already started"}`);
  } catch (err) {
    await row("error", `check not started: ${errorLine(err)}`);
    throw err;
  }
}

export default {
  async scheduled(controller, env): Promise<void> {
    try {
      switch (controller.cron) {
        case DIGEST_CADENCE_CRON:
          await digestTick(env, controller.scheduledTime);
          break;
        case HEALTH_CHECK_CRON:
          await healthTick(env, controller.scheduledTime);
          break;
        default:
          throw new Error(`Unhandled cron: ${controller.cron}`);
      }
    } catch (err) {
      // One line, no stack: a drizzle error's later lines carry the query's parameters.
      console.error(`tick ${controller.cron} failed: ${errorLine(err)}`);
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
