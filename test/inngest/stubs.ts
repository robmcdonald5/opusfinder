/**
 * Shared stub seams for the @opusfinder/inngest Vitest suites (delivery / probe / digest orchestrators).
 * Ported from the old `packages/inngest/scripts/_stub.ts` smoke helper. Keeps the chainable-thenable Db
 * stub and the recording fake-step in ONE place so a fix to the await/draining or step-recording semantics
 * can't drift between suites.
 */
import type { Db } from "@opusfinder/db";

/**
 * A chainable-thenable Db stub: every property access / call returns the chain; `await` pops the next
 * queued value. The functions under test run their REAL drizzle/sql code (building query ASTs); only the
 * final await is faked. Queue ONE entry per awaited db call, in call order. The real SQL round-trip is
 * exercised by the @opusfinder/db PGlite suites, not here.
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

/**
 * Step tools shared by the inngest suites — a superset (run + sleep + sendEvent) that structurally satisfies
 * every narrower per-module interface: ProbeStepTools (run), DeliveryStepTools (run + sleep), and the digest
 * orchestrator tools (run + sleep + sendEvent). A wider recorder is assignable wherever a narrower shape is
 * required, so one helper drives all three.
 */
export interface RecordingStepTools {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, duration?: string): Promise<void>;
  sendEvent(id: string, events: unknown): Promise<void>;
}

export interface RecordingStep {
  /** step.run ids in call order. */
  runs: string[];
  /** step.sleep ids in call order. */
  sleeps: string[];
  /** step.sleep {id, duration} in call order — so a suite can pin the durable wait CADENCE, not just ids
   *  (the digest poll schedule encodes the interval only in the duration; its sleep id is the loop index). */
  sleepCalls: { id: string; duration?: string }[];
  /** step.sendEvent {id, events} in call order (fan-out payloads). */
  sentEvents: { id: string; events: unknown }[];
  tools: RecordingStepTools;
}

/** A fake Inngest step that records run/sleep/sendEvent ids (and sendEvent payloads) and runs run-fns inline. */
export function recordingStep(): RecordingStep {
  const runs: string[] = [];
  const sleeps: string[] = [];
  const sleepCalls: { id: string; duration?: string }[] = [];
  const sentEvents: { id: string; events: unknown }[] = [];
  return {
    runs,
    sleeps,
    sleepCalls,
    sentEvents,
    tools: {
      run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
        runs.push(id);
        return fn();
      },
      sleep: async (id: string, duration?: string): Promise<void> => {
        sleeps.push(id);
        sleepCalls.push({ id, duration });
      },
      sendEvent: async (id: string, events: unknown): Promise<void> => {
        sentEvents.push({ id, events });
      },
    },
  };
}
