import { DIGEST_CADENCE_CRON, HEALTH_CHECK_CRON, runHealthCheck } from "@opusfinder/digest";

import { errorLine, maxUsersPerTick, recordRun, runRecord, tickGate } from "./control";
import { healthDeps, type Env } from "./env";
import { orchestratorRunId, tickDate } from "./fan-out";

export { DigestRunWorkflow, DigestUserWorkflow } from "./workflows";

/**
 * The opusfinder digest Worker: two scheduled (cron) handlers, dispatched on `controller.cron`.
 *  - the daily digest tick starts the orchestrator Workflow (./workflows), which starts one Workflow run
 *    per user who is due;
 *  - the health check runs every 2 h, in this handler (one unit of work, retried by the next tick).
 * Both ride the scrapers Worker's ingestion ticks (10 min after one starts), so their Neon reads land
 * while Neon is already awake.
 *
 * The control plane's gate is the ONLY switch for both stages (./control.ts): each tick reads it first,
 * and off or unreadable means the tick does nothing but write its ledger row. Its own DB role
 * (`digest_worker`) and secrets: the scrapers Worker has no access to user tables or email, and this one
 * has none to ingestion's writes beyond the 410 close.
 *
 * The cron strings MUST match wrangler.toml [triggers].crons character for character
 * (worker.integration.test.ts reads that array), and an unknown one throws, so a stale trigger is an
 * errored invocation, not a silent no-op.
 */

async function digestTick(env: Env, scheduledTimeMs: number): Promise<void> {
  const startedMs = Date.now();
  const tick = tickDate(scheduledTimeMs);
  const gate = await tickGate(env.CONTROL, "digest");
  const row = (outcome: "error" | "skipped", detail: string) =>
    recordRun(env.CONTROL, (finishedMs) =>
      runRecord("digest", startedMs, finishedMs, { outcome, gateMode: gate?.mode ?? null, detail }),
    );
  if (gate === null) return row("error", "gate unreadable");
  if (gate.mode === "off") return row("skipped", "off");
  const id = orchestratorRunId(tick);
  try {
    // A second fire for the same tick: production refuses the id, the local engine returns the first
    // instance. Either way one orchestrator runs, and it writes the tick's ledger row when it ends.
    await env.DIGEST_RUN.create({
      id,
      params: { tick, mode: gate.mode, maxUsers: maxUsersPerTick(gate) },
    });
    console.log(`digest tick ${tick}: started ${id} (${gate.mode})`);
  } catch (err) {
    if (await exists(env.DIGEST_RUN, id)) {
      console.warn(`digest tick ${tick}: ${id} was already started`);
      return;
    }
    await row("error", `run not started: ${errorLine(err)}`);
    throw err;
  }
}

async function exists(workflow: Env["DIGEST_RUN"], id: string): Promise<boolean> {
  try {
    await workflow.get(id);
    return true;
  } catch {
    return false;
  }
}

async function healthTick(env: Env): Promise<void> {
  const startedMs = Date.now();
  const gate = await tickGate(env.CONTROL, "alerts");
  const row = (outcome: "ok" | "error" | "skipped", detail: string) =>
    recordRun(env.CONTROL, (finishedMs) =>
      runRecord("alerts", startedMs, finishedMs, { outcome, gateMode: gate?.mode ?? null, detail }),
    );
  if (gate === null) return row("error", "gate unreadable");
  if (gate.mode === "off") return row("skipped", "off");
  try {
    const result = await runHealthCheck(healthDeps(env, gate));
    // Shape-only: check ids and counts.
    const detail =
      `${result.firing.length} firing · ${result.firingShadow.length} firing (logs only) · ` +
      `${result.notified.length} emailed · ${result.suppressed.length} in cooldown`;
    console.log(
      `health check: ${detail}` +
        (result.firing.length > 0 ? ` · firing: ${result.firing.join(", ")}` : "") +
        (result.firingShadow.length > 0 ? ` · logs only: ${result.firingShadow.join(", ")}` : ""),
    );
    await row("ok", detail);
  } catch (err) {
    await row("error", errorLine(err));
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
          await healthTick(env);
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
