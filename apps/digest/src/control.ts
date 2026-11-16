import {
  policies,
  stages,
  type GateAnswer,
  type PolicyDef,
  type RunOutcome,
  type StageMode,
} from "@opusfinder/control";
import { describeDbError } from "@opusfinder/db/errors";

/**
 * This Worker's side of the control plane: the `opusfinder-control` Worker, reached over the CONTROL
 * service binding (its `ControlRpc` entrypoint), which treats a binding caller as the runtime role.
 *
 * ENFORCED, unlike the scrapers Worker's shadow reading: the gate is the only switch for the `digest` and
 * `alerts` stages, and for what they read from it (the `close` policy, the per-tick user limit, the health
 * checks' modes and thresholds, the alert cooldown). No wrangler var mirrors any of it. Off means the tick
 * does nothing, and so does a gate that can't be read (no binding, no answer in time, a mode the stage
 * doesn't have): fail closed. `digest.topK` is the one registry knob still not read: it is a constant in
 * the stage code.
 * Runtime-neutral: no Workers or Node globals beyond timers and console.
 */

/** The stages this Worker runs. */
export type DigestWorkerStage = "digest" | "alerts";

/** One ledger row, as the control Worker's recordRun() validates it: units must be ones the stage declares. */
export interface RunRecord<S extends DigestWorkerStage = DigestWorkerStage> {
  stage: S;
  outcome: RunOutcome;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  gateMode: StageMode | null;
  units: Partial<Record<(typeof stages)[S]["units"][number], number>>;
  detail: string;
}

/** The CONTROL binding: the two `ControlRpc` methods this Worker calls. */
export interface ControlBinding {
  gate(stage: DigestWorkerStage): Promise<GateAnswer>;
  recordRun(run: RunRecord): Promise<unknown>;
}

// A binding call normally answers in milliseconds; past this the gate counts as unreadable and a ledger
// row as not written.
export const GATE_TIMEOUT_MS = 2_000;

/**
 * The first line of `text`, capped: what may leave the Worker in a ledger row. A multi-line message (a
 * stack, a wrapped drizzle `params:` line) must not get past its first newline.
 */
export function firstLine(text: string, max: number): string {
  return (text.split("\n")[0] ?? "").slice(0, max);
}

/** An error as one line for a log or a ledger row. A failed query reads as its Postgres reason and its
 *  SQL (describeDbError), never the `params:` line drizzle puts after them. */
export function errorLine(err: unknown): string {
  try {
    return firstLine(
      err instanceof Error ? `${err.name}: ${describeDbError(err)}` : String(err),
      200,
    );
  } catch {
    return "unprintable error";
  }
}

/** A stage's gate, its mode narrowed to the modes the stage has. */
export type StageGate<S extends DigestWorkerStage> = GateAnswer & {
  mode: (typeof stages)[S]["modes"][number];
};

/**
 * `stage`'s gate, as the control plane has it now. Throws when it can't be read within GATE_TIMEOUT_MS or
 * its mode isn't one of the stage's; callers treat that as off (a tick), as shadow (the 410 close) or
 * retry (the send step).
 */
export async function readGate<S extends DigestWorkerStage>(
  control: ControlBinding | undefined,
  stage: S,
): Promise<StageGate<S>> {
  if (!control) throw new Error("no CONTROL binding");
  const gate = await answerInTime(control.gate(stage));
  const modes: readonly string[] = stages[stage].modes;
  if (!modes.includes(gate?.mode)) throw new Error("malformed gate answer");
  return gate as StageGate<S>;
}

/** `call`'s answer, or a rejection once GATE_TIMEOUT_MS has passed: no call to the control Worker may
 *  hold a tick or a Workflow step longer than that. */
async function answerInTime<T>(call: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer in ${GATE_TIMEOUT_MS} ms`)),
          GATE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * The tick's gate, or null with the reason logged when the control plane can't be read: the tick then
 * does nothing, as if the stage were off. Never throws.
 */
export async function tickGate<S extends DigestWorkerStage>(
  control: ControlBinding | undefined,
  stage: S,
): Promise<StageGate<S> | null> {
  try {
    const gate = await readGate(control, stage);
    console.log(`control gate ${stage}: ${gate.mode}`);
    return gate;
  } catch (err) {
    console.error(`control gate ${stage}: unreadable, so off (${errorLine(err)})`);
    return null;
  }
}

/**
 * Whether the `close` policy enforces, for the pre-send probe's 410 close: the one policy row the scrapers
 * Worker's closes follow too. Anything but a readable `enforce` is shadow (the dead link is still dropped
 * from the digest; the job just isn't closed). Never throws.
 */
export async function closeEnforced(control: ControlBinding | undefined): Promise<boolean> {
  try {
    return (await readGate(control, "digest")).policies.close?.mode === "enforce";
  } catch (err) {
    console.warn(
      `control gate digest: unreadable, so the 410 close is not enforced (${errorLine(err)})`,
    );
    return false;
  }
}

/** The most per-user runs one tick starts (`digest.maxRecipientsPerRun`); the rest stay due for the next
 *  tick. An answer without a usable number falls back to the registry's default. */
export function maxUsersPerTick(gate: GateAnswer): number {
  const value = gate.knobs?.maxRecipientsPerRun;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : stages.digest.knobs.maxRecipientsPerRun.default;
}

/**
 * The `alerts` gate's health checks and cooldown, spelled as the HEALTH_* variables `healthOptionsFromEnv`
 * and `getHealthAlertCooldownH` parse (each threshold knob names its variable in the registry, and the
 * parser accepts the panel's `health.<id>` spelling). So the control panel's check rows are what the
 * health tick runs with: a check emails only when its row says enforce, and a check whose watched stage is
 * off is skipped.
 */
export function healthVars(gate: GateAnswer): Record<string, string> {
  const vars: Record<string, string> = {};
  const enforce: string[] = [];
  const off: string[] = [];
  for (const [id, policy] of Object.entries(gate.policies ?? {})) {
    if (!id.startsWith("health.")) continue;
    if (policy.mode === "off" || policy.watchedStageOff) off.push(id);
    else if (policy.mode === "enforce") enforce.push(id);
    const knob = (policies as Record<string, PolicyDef>)[id]?.knobs?.threshold;
    const threshold = policy.knobs?.threshold;
    if (knob?.legacyEnv && typeof threshold === "number") vars[knob.legacyEnv] = String(threshold);
  }
  vars.HEALTH_ENFORCE = enforce.join(",");
  vars.HEALTH_OFF = off.join(",");
  const cooldown = gate.knobs?.cooldownH;
  if (typeof cooldown === "number") {
    vars[stages.alerts.knobs.cooldownH.legacyEnv] = String(cooldown);
  }
  return vars;
}

/**
 * Write one ledger row, best effort. Any failure, from building the row to the control Worker refusing it
 * or not answering within GATE_TIMEOUT_MS, is logged, never thrown: the ledger must not change a tick's or
 * a run's outcome, or hold it up. No binding ⇒ nothing to do.
 */
export async function recordRun(
  control: ControlBinding | undefined,
  build: (finishedMs: number) => RunRecord,
): Promise<void> {
  if (!control) return;
  try {
    await answerInTime(control.recordRun(build(Date.now())));
  } catch (err) {
    console.warn(`control ledger: run not recorded (${errorLine(err)})`);
  }
}

/** A stage's ledger row for a run that started at `startedMs`. */
export function runRecord<S extends DigestWorkerStage>(
  stage: S,
  startedMs: number,
  finishedMs: number,
  row: { outcome: RunOutcome; gateMode: StageMode | null; detail: string },
): RunRecord<S> {
  const durationMs = Math.max(0, finishedMs - startedMs);
  return {
    stage,
    outcome: row.outcome,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(finishedMs).toISOString(),
    durationMs,
    gateMode: row.gateMode,
    units: { "cf.wall_ms": durationMs } as RunRecord<S>["units"],
    detail: firstLine(row.detail, 300),
  };
}
