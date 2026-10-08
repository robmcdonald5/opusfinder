import type { GateView, RunOutcome, StageMode, stages } from "@opusfinder/control";
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
 * Only TYPES come from @opusfinder/control (erased at build): nothing of the control plane is bundled here.
 */

/** The stages this Worker runs. */
export type ScrapersStage = "ingest" | "discover";

/** What the control Worker's gate() answers that this Worker reads: its GateView plus the latest change. */
type GateAnswer = Pick<GateView, "mode" | "cappedBy" | "knobs"> & {
  by: string | null;
  because: string | null;
};

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

/** When the tick started and what its gate said (null = unreadable): shared by the tick's ledger row. */
export interface TickStart {
  startedMs: number;
  gateMode: StageMode | null;
}

// A binding call normally answers in milliseconds; past this the gate counts as unreadable.
export const GATE_TIMEOUT_MS = 2_000;

/** The first line of `text`, capped: a drizzle error's second line is its bound params. */
function firstLine(text: string, max: number): string {
  return (text.split("\n")[0] ?? "").slice(0, max);
}

function errorLine(err: unknown): string {
  return firstLine(err instanceof Error ? `${err.name}: ${err.message}` : String(err), 200);
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
    // Fail closed on an answer this Worker can't read, as an enforcing tick would.
    if (!["off", "shadow", "on"].includes(gate?.mode)) throw new Error("malformed gate answer");
    return gate;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read `stage`'s gate and log one line: `on (shadow: not enforced)`, or `would skip: …` when it says off
 * or can't be read within GATE_TIMEOUT_MS. Plus a drift line when the gate's knobs differ from `used`, the
 * values this tick actually runs with. Returns the gate's mode for the ledger row (null = unreadable).
 * Never throws; the caller runs the tick whatever it returns.
 */
export async function shadowGate(
  control: ControlBinding | undefined,
  stage: ScrapersStage,
  used: Readonly<Record<string, number>>,
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
    }
    const drift = Object.entries(used)
      .filter(([knob, value]) => gate.knobs?.[knob] !== value)
      .map(
        ([knob, value]) => `${knob} ${gate.knobs?.[knob] ?? "unset"} (gate) vs ${value} (in use)`,
      );
    if (drift.length > 0) console.warn(`${tag} knobs differ, not enforced: ${drift.join(", ")}`);
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
    durationMs: finishedMs - tick.startedMs,
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
  return {
    stage: "ingest",
    outcome: budgetStop ? "partial" : "ok",
    ...timing(tick, finishedMs),
    units: {
      "cf.wall_ms": finishedMs - tick.startedMs,
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
  return {
    stage: "discover",
    outcome: "ok",
    ...timing(tick, finishedMs),
    units: { "cf.wall_ms": finishedMs - tick.startedMs },
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
  return {
    stage,
    outcome: "error",
    ...timing(tick, finishedMs),
    units: { "cf.wall_ms": finishedMs - tick.startedMs },
    detail: firstLine(message, 300),
  };
}
