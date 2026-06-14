/**
 * Shared stub seams for the @opusfinder/inngest stub-smoke scripts (test-digest-email, test-digest-probe).
 * NOT a script entry point (leading `_`). Keeps the chainable-thenable Db stub and the recording fake-step
 * in ONE place so a fix to the await/draining semantics can't drift between the two smokes.
 */
import type { Db } from "@opusfinder/db";

/**
 * A chainable-thenable Db stub: every property access / call returns the chain; `await` pops the next queued
 * value. The repo functions under test run their REAL drizzle/sql code (building query ASTs); only the final
 * await is faked. One queued entry per awaited db call, in call order. The real SQL round-trip is exercised by
 * the @opusfinder/db smokes, not here.
 */
export function stubDb(queued: unknown[]): Db {
  const target = (): void => undefined;
  const chain: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
          if (queued.length === 0) reject(new Error("stubDb: no queued result left"));
          else resolve(queued.shift());
        };
      }
      return () => chain;
    },
    apply() {
      return chain;
    },
  });
  return chain as Db;
}

/** Step tools shared by the smokes — a superset (run + sleep) structurally satisfying both ProbeStepTools
 *  (run only) and DeliveryStepTools (run + sleep). */
export interface RecordingStepTools {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, duration?: string): Promise<void>;
}

/** A fake Inngest step that records run/sleep ids and runs fns inline. */
export function recordingStep(): { runs: string[]; sleeps: string[]; tools: RecordingStepTools } {
  const runs: string[] = [];
  const sleeps: string[] = [];
  return {
    runs,
    sleeps,
    tools: {
      run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
        runs.push(id);
        return fn();
      },
      sleep: async (id: string): Promise<void> => {
        sleeps.push(id);
      },
    },
  };
}
