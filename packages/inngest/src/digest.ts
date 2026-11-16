/**
 * The digest pipeline as Inngest functions: thin adapters over the stage code in @opusfinder/digest
 * (`runOrchestrator`, `runPerUser`), which the digest Worker (apps/digest) runs on Cloudflare Workflows.
 * Kept, paused, until the Worker has run in production; then this package is deleted.
 */
import {
  DIGEST_CADENCE_CRON,
  NonRetriableError as StageNonRetriableError,
  runOrchestrator,
  runPerUser,
  type DigestDeps,
} from "@opusfinder/digest";
import { NonRetriableError } from "inngest";

import { inngest } from "./inngest";

/** The stage code's no-retry error as Inngest's, so a step that throws it isn't retried. */
async function translating<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw err instanceof StageNonRetriableError
      ? new NonRetriableError(err.message, { cause: err })
      : err;
  }
}

/** Wraps runOrchestrator as the Inngest fn; the adapter passes Inngest's tools through (Jsonify→T cast). */
function makeOrchestrator(deps: DigestDeps) {
  return inngest.createFunction(
    { id: "digest-orchestrator" },
    { event: "digest/run.requested" },
    ({ event, step }) =>
      translating(() =>
        runOrchestrator(deps, event, {
          run: async (id, fn) =>
            (await step.run(id, () => translating(fn))) as Awaited<ReturnType<typeof fn>>,
          sendEvent: async (id, events) => {
            await step.sendEvent(id, events);
          },
        }),
      ),
  );
}

/**
 * Wraps runPerUser as the Inngest fn. `singleton` keyed on userId (mode `skip`) prevents overlapping runs
 * for one user — `concurrency` cannot: a run sleeping through the batch wait holds no concurrency slot.
 * `skip` (not `cancel`) so an in-flight paid batch is never abandoned.
 */
function makePerUser(deps: DigestDeps) {
  return inngest.createFunction(
    { id: "digest-user", singleton: { key: "event.data.userId", mode: "skip" } },
    { event: "digest/user.requested" },
    ({ event, step }) =>
      translating(() =>
        runPerUser(deps, event, {
          run: async (id, fn) =>
            (await step.run(id, () => translating(fn))) as Awaited<ReturnType<typeof fn>>,
          sleep: (id, duration) => step.sleep(id, duration),
        }),
      ),
  );
}

/**
 * The cadence cron: a daily {cron} that EMITS `digest/run.requested {trigger:'cron'}`, reusing the
 * orchestrator's recipient sweep + fan-out. Emits only (no deps); all the work is the orchestrator's.
 */
function makeCadenceOrchestrator() {
  return inngest.createFunction(
    { id: "digest-cadence", singleton: { mode: "skip" } },
    { cron: DIGEST_CADENCE_CRON },
    async ({ step }) => {
      await step.sendEvent("emit-cadence-run", {
        name: "digest/run.requested",
        data: { trigger: "cron" },
      });
      return { emitted: true };
    },
  );
}

/** The Inngest functions for the digest pipeline, wired to `deps`. Served via `createAllFunctions`
 *  (./functions). */
export function createDigestFunctions(deps: DigestDeps) {
  return [makeOrchestrator(deps), makePerUser(deps), makeCadenceOrchestrator()];
}
