import type { PerUserEvent, UserRequestedEvent } from "@opusfinder/digest";

/**
 * The orchestrator's fan-out: start one per-user Workflow run for each user who is due, and never two runs
 * for one user at once. Runtime-neutral (the Workflow binding and the store come in as parameters).
 *
 * A run's id is the user plus the tick's UTC date, so a second start on the same tick (a double cron fire,
 * a retried fan-out step) finds the first and starts nothing. The date, not the user's week: a run that
 * fails doesn't stamp the user's cadence, so the user is due again at the next daily tick and gets a fresh
 * run under the next date's id.
 *
 * That leaves a run that outlives its tick (the synthesis batch may take a day, and step retries add to
 * it). The store (`user_preferences.digest_instance_id`) names the instance last started for each user,
 * written before the start, so the tick asks the engine about exactly that instance and skips the user
 * while it hasn't finished. By induction a user has at most one unfinished run, however many ticks it
 * spans.
 */

/** The part of a Workflows binding (`Workflow<PerUserEvent["data"]>`) the fan-out uses. */
export interface UserRunBinding {
  create(options: { id: string; params: PerUserEvent["data"] }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
}

/** Where the instance last started for each user is kept (@opusfinder/db's `getDigestInstances` and
 *  `setDigestInstance` in the Worker). */
export interface InstanceStore {
  /** The last instance id of each of these users; a user with none is absent. */
  last(userIds: string[]): Promise<ReadonlyMap<string, string>>;
  record(userId: string, instanceId: string): Promise<void>;
}

/** The UTC date of a cron tick, from its scheduled time: the period a run id carries. */
export function tickDate(scheduledTimeMs: number): string {
  return new Date(scheduledTimeMs).toISOString().slice(0, 10);
}

const TICK_LENGTH = "YYYY-MM-DD".length;

/** The per-user run's instance id (47 characters; Workflows allows 100 of [a-zA-Z0-9_-]). */
export function userRunId(userId: string, tick: string): string {
  return `${userId}_${tick}`;
}

/** The orchestrator's instance id: one per tick, so a double cron fire opens one `digest_runs` row. */
export function orchestratorRunId(tick: string): string {
  return `digest-run_${tick}`;
}

export interface FanOutResult {
  /** Runs started by this call. */
  started: number;
  /** Users skipped because their previous run hasn't finished. */
  inFlight: number;
  /** Users whose run for this tick already existed. */
  alreadyStarted: number;
  /** Users left for the next tick because this one reached its limit (`digest.maxRecipientsPerRun`). */
  overLimit: number;
}

const FINISHED = new Set(["complete", "errored", "terminated"]);

/** The instance's status, or null when the engine has no such instance (never started, or past its
 *  retention). Any other failure is thrown: guessing "not running" there could start a second run. */
async function statusOf(binding: UserRunBinding, id: string): Promise<string | null> {
  try {
    return (await (await binding.get(id)).status()).status;
  } catch (err) {
    if (err instanceof Error && /not[._ ]?found|does not exist/i.test(err.message)) return null;
    throw err;
  }
}

/**
 * Start the per-user runs for `events` on tick `tick`, at most `maxUsers` of them (runs this tick already
 * started count toward it). The limit is a runaway guard, not a schedule: a user over it stays due and is
 * counted, and users are taken longest-waiting first (never started, then by the tick their last run was
 * started on), so a user left out today is ahead of everyone started today and none is starved, even by
 * users whose runs fail every day. One user's failure doesn't stop the others; it is thrown after the loop,
 * so the step is retried and the retry finds the started runs already there.
 */
export async function startUserRuns(
  store: InstanceStore,
  binding: UserRunBinding,
  events: UserRequestedEvent[],
  tick: string,
  maxUsers: number,
): Promise<FanOutResult> {
  const result: FanOutResult = { started: 0, inFlight: 0, alreadyStarted: 0, overLimit: 0 };
  const failures: string[] = [];
  const fail = (err: unknown) =>
    failures.push(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  const last = await store.last(events.map((event) => event.data.userId));

  // First, who can be started at all: not a user with an unfinished run, not one this tick already
  // started (those count toward the limit before anyone new does).
  const startable: UserRequestedEvent[] = [];
  for (const event of events) {
    const { userId } = event.data;
    const id = userRunId(userId, tick);
    try {
      const previous = last.get(userId);
      const previousStatus =
        previous !== undefined && previous !== id ? await statusOf(binding, previous) : null;
      if (previousStatus !== null && !FINISHED.has(previousStatus)) result.inFlight++;
      else if ((await statusOf(binding, id)) !== null) result.alreadyStarted++;
      else startable.push(event);
    } catch (err) {
      fail(err);
    }
  }

  // Then start them, longest-waiting first, up to the limit. A run id ends in its tick's date, which
  // sorts as text; a user with no run yet sorts first. The sort is stable, so ties keep the sweep's order.
  const lastTick = (userId: string) => last.get(userId)?.slice(-TICK_LENGTH) ?? "";
  startable.sort((a, b) => lastTick(a.data.userId).localeCompare(lastTick(b.data.userId)));
  for (const { data } of startable) {
    if (result.started + result.alreadyStarted >= maxUsers) {
      result.overLimit++;
      continue;
    }
    const id = userRunId(data.userId, tick);
    try {
      await store.record(data.userId, id);
      await binding.create({ id, params: data });
      result.started++;
    } catch (err) {
      fail(err);
    }
  }
  console.log(
    `digest fan-out ${tick}: ${events.length} due, ${result.started} started, ` +
      `${result.inFlight} still running, ${result.alreadyStarted} already started, ` +
      `${result.overLimit} over the limit of ${maxUsers}, ${failures.length} failed`,
  );
  if (failures.length > 0) {
    const first = (failures[0] ?? "").split("\n")[0]?.slice(0, 200);
    throw new Error(`${failures.length} of ${events.length} user run(s) not started: ${first}`);
  }
  return result;
}
