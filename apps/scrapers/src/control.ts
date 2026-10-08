import { stages, type GateAnswer, type RunOutcome, type StageMode } from "@opusfinder/control";
import type { DiscoveryCounts } from "@opusfinder/discovery";
import type { IngestionCounts } from "@opusfinder/sources";

/**
 * This Worker's side of the control plane: the `opusfinder-control` Worker, reached over the CONTROL
 * service binding (its `ControlRpc` entrypoint), which treats a binding caller as the runtime role. SHADOW
 * ONLY: each tick reads its stage's gate at the start and LOGS what the gate says (and what it would do once
 * enforced), then runs exactly as before — the env vars and constants still rule — and writes one ledger row
 * at the end. Nothing here throws into the tick: a slow, missing or failing control plane is logged and the
 * tick goes on (an unreadable gate is what will make an enforcing tick skip, so it is logged as "would skip").
 *
 * Of the control plane, only the pure registry (@opusfinder/control: each stage's modes) is bundled here.
 */

/** The stages this Worker runs. */
export type ScrapersStage = "ingest" | "discover";

/** One ledger row, as the control Worker's recordRun() validates it: units must be ones the stage declares. */
export interface RunRecord<S extends ScrapersStage = ScrapersStage> {
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
  gate(stage: ScrapersStage): Promise<GateAnswer>;
  recordRun(run: RunRecord): Promise<unknown>;
}

/**
 * The settings a tick actually runs with, keyed like the gate's: a stage knob by name (`boardsPerTick`), a
 * policy by id (`close`, its mode) and a policy knob as `<policy>.<knob>` (`stale_sweep.ttlDays`).
 */
export type InUse = Readonly<Record<string, number | string>>;

/** When the tick started and what its gate said (null = unreadable): shared by the tick's ledger row. */
export interface TickStart {
  startedMs: number;
  gateMode: StageMode | null;
}

// A binding call normally answers in milliseconds; past this the gate counts as unreadable.
export const GATE_TIMEOUT_MS = 2_000;

/**
 * The first line of `text`, capped: what may leave the tick in a log row or a ping. A multi-line message (a
 * stack, a wrapped drizzle `params:` line) must not get past its first newline.
 */
export function firstLine(text: string, max: number): string {
  return (text.split("\n")[0] ?? "").slice(0, max);
}

function errorLine(err: unknown): string {
  try {
    return firstLine(err instanceof Error ? `${err.name}: ${err.message}` : String(err), 200);
  } catch {
    return "unprintable error"; // e.g. a rejection value whose String() throws: still never thrown here
  }
}

async function readGate(control: ControlBinding | undefined, stage: ScrapersStage) {
  if (!control) throw new Error("no CONTROL binding");
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const gate = await Promise.race([
      control.gate(stage),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer in ${GATE_TIMEOUT_MS} ms`)),
          GATE_TIMEOUT_MS,
        );
      }),
    ]);
    // Fail closed, as an enforcing tick would, on an answer this Worker can't read or a mode its stage
    // doesn't have (the control Worker would refuse that mode in the ledger row too).
    const modes: readonly string[] = stages[stage].modes;
    if (!modes.includes(gate?.mode)) throw new Error("malformed gate answer");
    return gate;
  } finally {
    clearTimeout(timer);
  }
}

/** The gate's knobs and policies, keyed like {@link InUse}. */
function gateValues(gate: GateAnswer): Record<string, number | string> {
  const values: Record<string, number | string> = { ...gate.knobs };
  for (const [id, policy] of Object.entries(gate.policies ?? {})) {
    values[id] = policy.mode;
    for (const [knob, value] of Object.entries(policy.knobs ?? {})) values[`${id}.${knob}`] = value;
  }
  return values;
}

/**
 * Read `stage`'s gate and log one line: `on (shadow: not enforced)`, or `would skip: …` when it says off
 * or can't be read within GATE_TIMEOUT_MS. When it says on, another line names the slices its overrides
 * turn off (e.g. `source=workable`). And a drift line when the gate's knobs or policies differ from
 * `inUse`, what this tick actually runs with. Returns the gate's mode for the ledger row (null =
 * unreadable). Never throws; the caller runs the tick whatever it returns.
 */
export async function shadowGate(
  control: ControlBinding | undefined,
  stage: ScrapersStage,
  inUse: InUse,
): Promise<StageMode | null> {
  const tag = `control gate ${stage}:`;
  try {
    const gate = await readGate(control, stage);
    if (gate.mode === "off") {
      const why =
        gate.cappedBy === "global"
          ? "master switch off"
          : `by ${gate.by ?? "default"}: ${gate.because ?? "no reason"}`;
      console.warn(`${tag} would skip: off (${why})`);
    } else {
      console.log(`${tag} ${gate.mode} (shadow: not enforced)`);
      const slices = Object.entries(gate.overrides ?? {}).flatMap(([dim, byValue]) =>
        Object.entries(byValue ?? {})
          .filter(([, mode]) => mode === "off")
          .map(([value]) => `${dim}=${value}`),
      );
      if (slices.length > 0) console.warn(`${tag} would skip ${slices.join(", ")} (overrides)`);
    }
    const values = gateValues(gate);
    const drift = Object.entries(inUse)
      .filter(([key, value]) => values[key] !== value)
      .map(([key, value]) => `${key} ${values[key] ?? "unset"} (gate) vs ${value} (in use)`);
    if (drift.length > 0) console.warn(`${tag} settings differ, not enforced: ${drift.join(", ")}`);
    return gate.mode;
  } catch (err) {
    console.warn(`${tag} would skip: control plane unreadable (${errorLine(err)})`);
    return null;
  }
}

/**
 * Write the tick's ledger row in the background (`ctx.waitUntil`), so it can't delay the tick, change its
 * outcome or get in the way of the watchdog pings. `build` runs inside the same guard: any failure, from
 * building the row to the control Worker refusing it, is logged, never thrown. No binding ⇒ nothing to do.
 */
export function recordRun(
  control: ControlBinding | undefined,
  ctx: ExecutionContext,
  build: (finishedMs: number) => RunRecord,
): void {
  if (!control) return;
  ctx.waitUntil(
    Promise.resolve(Date.now())
      .then(build)
      .then((run) => control.recordRun(run))
      .then(
        () => undefined,
        (err: unknown) => console.warn(`control ledger: run not recorded (${errorLine(err)})`),
      ),
  );
}

function timing(tick: TickStart, finishedMs: number) {
  return {
    startedAt: new Date(tick.startedMs).toISOString(),
    finishedAt: new Date(finishedMs).toISOString(),
    durationMs: finishedMs - tick.startedMs, // also the row's cf.wall_ms
    gateMode: tick.gateMode,
  };
}

const n = (value: number) => value.toLocaleString("en-US");

/** `partial` when the run budget stopped the chunk early (the rest carries to the next tick). */
export function ingestRun(
  tick: TickStart,
  finishedMs: number,
  counts: IngestionCounts,
): RunRecord<"ingest"> {
  const budgetStop = counts.processed < counts.companies;
  const time = timing(tick, finishedMs);
  return {
    stage: "ingest",
    outcome: budgetStop ? "partial" : "ok",
    ...time,
    units: {
      "cf.wall_ms": time.durationMs,
      "ingest.boards": counts.processed,
      "ingest.boards_failed": counts.failed,
      "ingest.boards_rate_limited": counts.rateLimitSkipped,
      "ingest.jobs_changed": counts.changed,
    },
    detail: [
      `${n(counts.processed)}/${n(counts.companies)} boards`,
      `${n(counts.failed)} failed`,
      `${n(counts.rateLimitSkipped)} rate-limited`,
      `${n(counts.changed)} changed`,
      ...(budgetStop ? ["budget stop"] : []),
    ].join(" · "),
  };
}

export function discoverRun(
  tick: TickStart,
  finishedMs: number,
  counts: DiscoveryCounts,
): RunRecord<"discover"> {
  const time = timing(tick, finishedMs);
  return {
    stage: "discover",
    outcome: "ok",
    ...time,
    units: { "cf.wall_ms": time.durationMs },
    detail: [
      `${n(counts.candidates)} candidates`,
      `${n(counts.probed)} probed`,
      `${n(counts.upserted)} upserted`,
      `${n(counts.reprobed)} re-probed`,
      `${n(counts.deactivated)} deactivated`,
    ].join(" · "),
  };
}

/** A tick that threw. `message` is cut to its first line, like the watchdog's failure ping. */
export function errorRun(
  stage: ScrapersStage,
  tick: TickStart,
  finishedMs: number,
  message: string,
): RunRecord {
  const time = timing(tick, finishedMs);
  return {
    stage,
    outcome: "error",
    ...time,
    units: { "cf.wall_ms": time.durationMs },
    detail: firstLine(message, 300),
  };
}
