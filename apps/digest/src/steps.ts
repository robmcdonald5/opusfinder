import { describeDbError } from "@opusfinder/db/errors";
import { NonRetriableError } from "@opusfinder/digest";

/**
 * The digest stages' step tools (`run`, `sleep`) over a Cloudflare Workflows step. Runtime-neutral: the
 * step and the engine's no-retry error come in as parameters, so the node suites drive this file against a
 * recording step and workflows.ts hands it the real ones.
 */

/** The part of a Workflows `WorkflowStep` the stages need. */
export interface WorkflowStepLike {
  do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, durationMs: number): Promise<void>;
}

export interface StepConfig {
  retries: { limit: number; delay: number; backoff: "constant" | "linear" | "exponential" };
  timeout: number;
}

/**
 * Every step's retry policy: what the stages ran under on Inngest, not the Workflows defaults (5 retries,
 * 10 minutes). Four retries after the first attempt was Inngest's default and the stages set no other. The
 * waits double from 15 s (15, 30, 60, 120 s). An attempt is cut off at 5 minutes, the limit one step had as
 * a Vercel function call. A step that throws the stages' NonRetriableError is not retried at all.
 */
export const STEP_CONFIG: StepConfig = {
  retries: { limit: 4, delay: 15_000, backoff: "exponential" },
  timeout: 5 * 60_000,
};

/**
 * The one step with its own policy, a deliberate departure from the Inngest retry count: `record-sent`,
 * the write that stamps a digest as sent after Resend accepted it. If it gave up after the usual four
 * retries (about four minutes of Neon failing), the run would end with an email out but no `sent_at` and
 * no cadence stamp, and the next daily tick would build the user a second digest, sent under a new
 * idempotency key. The write is idempotent and nothing can be taken back by not retrying it, so it keeps
 * trying for about 15 hours (60 retries, the wait growing by 30 s each time, up to 30 minutes). The user's
 * instance stays unfinished meanwhile, so later ticks skip the user.
 */
export const RECORD_SENT_CONFIG: StepConfig = {
  retries: { limit: 60, delay: 30_000, backoff: "linear" },
  timeout: 5 * 60_000,
};

/** The retry policy of the stage step `id`. */
export function stepConfig(id: string): StepConfig {
  return id === "record-sent" ? RECORD_SENT_CONFIG : STEP_CONFIG;
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/** A stage's wait ("30s", "2m", "10m") in milliseconds. Workflows spells durations differently, and a
 *  string it can't read would fail the run mid-wait, so anything else throws here. */
export function durationMs(duration: string): number {
  const match = /^(\d+)([smh])$/.exec(duration);
  if (!match) throw new Error(`unreadable step duration "${duration}"`);
  return Number(match[1]) * UNIT_MS[match[2]!]!;
}

const FAILED_QUERY = "Failed query: ";

/**
 * What a failed step hands the engine. Workflows keeps a step's error (name and message, not its cause)
 * in the instance's stored state and rethrows it into the run, so:
 *  - the stages' no-retry error becomes the engine's, which stops the retries (its reason is logged);
 *  - a failed query is reduced to its Postgres reason and its SQL. drizzle's message carries the query's
 *    parameters (user and job data) on a `params:` line, and the reason rides the cause the engine drops.
 */
function forEngine(id: string, err: unknown, nonRetryable: (message: string) => Error): unknown {
  if (err instanceof NonRetriableError) {
    // The engine reports an unhandled no-retry error as a generic "a step threw an NonRetryableError",
    // so the reason goes to the log here. Stage messages carry ids and counts, never user text.
    console.error(`digest: step ${id} failed and is not retried: ${err.message}`);
    return nonRetryable(err.message);
  }
  if (err instanceof Error && err.message.startsWith(FAILED_QUERY)) {
    const described = describeDbError(err);
    // describeDbError leads with the reason; with none, keep the text from reading as a raw drizzle message.
    return new Error(
      described.startsWith(FAILED_QUERY) ? `query failed | ${described}` : described,
    );
  }
  return err;
}

/**
 * `run` and `sleep` for the stage code, backed by a Workflows step. `nonRetryable` builds the engine's
 * `NonRetryableError` (from `cloudflare:workflows`, which only exists in the Workers runtime). `configFor`
 * is each step's retry policy ({@link stepConfig}; a suite passes one with shorter waits).
 */
export function workflowStepTools(
  step: WorkflowStepLike,
  nonRetryable: (message: string) => Error,
  configFor: (id: string) => StepConfig = stepConfig,
): {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, duration: string): Promise<void>;
} {
  return {
    run: (id, fn) =>
      step.do(id, configFor(id), async () => {
        try {
          return await fn();
        } catch (err) {
          throw forEngine(id, err, nonRetryable);
        }
      }),
    sleep: (id, duration) => step.sleep(id, durationMs(duration)),
  };
}
