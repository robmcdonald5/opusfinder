/**
 * The scrapers Worker's location run (apps/scrapers, its own cron a few minutes into each ingest tick):
 * the daily path of ./resolve under a bound, recorded as a `locations` source_runs row. A run asks at most
 * `maxPairs` pairs and starts no chunk past `maxRunMs`; whatever is left waits for the next run. Nothing
 * here keeps a cursor: the queue is the set of active pairs with no row, read fresh by every chunk.
 *
 * A pair whose request failed transiently is skipped for the rest of its run and handed back in
 * `failedPairs`. The caller passes them to the next run as `askLast`, which asks every other waiting pair
 * first, so pairs that keep failing can't hold the head of the queue.
 */
import type { Db } from "@opusfinder/db";
import { describeDbError } from "@opusfinder/db/errors";
import { countMissingPairs, finishRun, startRun, type LocationPairKey } from "@opusfinder/db/repos";

import { loadGazetteer } from "./check";
import type { LocationModel } from "./model";
import {
  addSpend,
  LocationModelUnavailableError,
  noSpend,
  SYNC_CHUNK,
  syncLocationStrings,
} from "./resolve";

/** What a location run did, as its source_runs row stores it. */
export interface LocationRunCounts {
  /** Pairs with no row when the run started. */
  pending: number;
  /** Pairs sent to the model. */
  asked: number;
  /** Pairs stored with a checked answer. */
  resolved: number;
  /** Pairs stored as unresolved: a deterministic no-answer. */
  unanswered: number;
  /** Pairs left without a row: the request failed transiently, so a later run asks again. */
  failed: number;
  /** Places the model named that failed the GeoNames check, across the stored pairs. */
  unmatchedPlaces: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** What the provider charged for the run's requests. */
  costUsd: number;
  [key: string]: number;
}

export interface LocationRunResult {
  counts: LocationRunCounts;
  /**
   * Why the run ended. `counted`: `apply` was false. `drained`: no pair is left waiting, bar the ones that
   * failed. `pair-bound` / `time-bound`: a bound stopped it with pairs waiting. `model-unavailable`: every
   * request of a chunk failed, so the run stopped asking.
   */
  stopped: "counted" | "drained" | "pair-bound" | "time-bound" | "model-unavailable";
  /** The pairs for the next run to ask last: this run's transient failures, and the `askLast` pairs it
   *  never reached. */
  failedPairs: LocationPairKey[];
  /** Set when the model failed every request and the run stored nothing: it reads as a provider outage,
   *  and the run's row is an `error`. */
  unavailable?: string;
}

/**
 * One location run. `apply: false` only counts the waiting pairs. A failure that isn't the model's (a
 * query, a missing key) finishes the row as `error` and re-throws.
 */
export async function runLocationResolve(
  db: Db,
  model: LocationModel,
  opts: { apply: boolean; maxPairs: number; maxRunMs: number; askLast?: LocationPairKey[] },
): Promise<LocationRunResult> {
  const startedMs = Date.now();
  const runId = await startRun(db, "locations");
  const counts: LocationRunCounts = {
    pending: 0,
    asked: 0,
    resolved: 0,
    unanswered: 0,
    failed: 0,
    unmatchedPlaces: 0,
    ...noSpend(),
  };
  try {
    counts.pending = await countMissingPairs(db);
    if (!opts.apply) {
      await finishRun(db, runId, { status: "ok", counts });
      return { counts, stopped: "counted", failedPairs: opts.askLast ?? [] };
    }

    const failedPairs: LocationPairKey[] = [];
    // With nothing waiting, last run's failures are no longer waiting either.
    let held = counts.pending > 0 ? (opts.askLast ?? []) : [];
    let stopped: LocationRunResult["stopped"] = "drained";
    let unavailable: string | undefined;
    const gazetteer = counts.pending > 0 ? await loadGazetteer(db) : undefined;
    while (counts.pending > 0) {
      if (counts.asked >= opts.maxPairs) {
        stopped = "pair-bound";
        break;
      }
      if (Date.now() - startedMs >= opts.maxRunMs) {
        stopped = "time-bound";
        break;
      }
      try {
        const chunk = await syncLocationStrings(db, model, {
          limit: Math.min(SYNC_CHUNK, opts.maxPairs - counts.asked),
          gazetteer,
          exclude: [...held, ...failedPairs],
        });
        counts.asked += chunk.resolved + chunk.unanswered + chunk.failed;
        counts.resolved += chunk.resolved;
        counts.unanswered += chunk.unanswered;
        counts.failed += chunk.failed;
        counts.unmatchedPlaces += chunk.unmatchedPlaces;
        addSpend(counts, chunk.spend);
        failedPairs.push(...chunk.failedPairs);
        if (chunk.more) continue;
        // Nothing else is waiting: now the pairs that failed last run, if any.
        if (held.length === 0) break;
        held = [];
      } catch (err) {
        if (!(err instanceof LocationModelUnavailableError)) throw err;
        counts.asked += err.failedPairs.length;
        counts.failed += err.failedPairs.length;
        failedPairs.push(...err.failedPairs);
        stopped = "model-unavailable";
        if (counts.resolved + counts.unanswered === 0) unavailable = err.message;
        break;
      }
    }

    await finishRun(
      db,
      runId,
      unavailable
        ? { status: "error", counts, errorSample: unavailable.slice(0, 500) }
        : { status: "ok", counts },
    );
    return { counts, stopped, failedPairs: [...failedPairs, ...held], unavailable };
  } catch (err) {
    // describeDbError: a failed query's Postgres reason, redacted, never its params.
    const errorSample = describeDbError(err).slice(0, 500);
    await finishRun(db, runId, { status: "error", counts, errorSample }).catch(() => {});
    throw err;
  }
}
