/**
 * Resolve (company, raw) location pairs into `location_strings` rows: build the requests, ask the model,
 * check its answers against GeoNames, store them. Two entry points over the same request builder and the
 * same answer handling: {@link syncLocationStrings}, the daily path (pairs with no row yet, a few
 * requests at a time, run by the digest before its fan-out and by `locations:sync`), and
 * {@link backfillLocationStrings}, provider batches over every missing, stale or unanswered pair
 * (`locations:backfill`), with {@link collectLocationBatch} to store a batch submitted by an earlier run.
 *
 * What gets stored: a checked answer, and an unresolved row (confidence NULL) for a deterministic
 * no-answer, which `locations:report` lists and only the backfill asks again. A transient failure stores
 * nothing, so the next run asks again.
 */
import { createHash } from "node:crypto";

import type { Db } from "@opusfinder/db";
import {
  listCompanyStrings,
  listPendingPairs,
  upsertLocationStrings,
  type LocationPair,
  type LocationPairKey,
  type LocationStringRow,
} from "@opusfinder/db/repos";

import { checkAnswers, loadGazetteer, type Gazetteer } from "./check";
import {
  BATCH_SIZE,
  buildLocationRequest,
  type LocationAnswer,
  type LocationModel,
  type LocationRequest,
} from "./model";
import { PROMPT_VERSION, SIBLING_CONTEXT, type PromptPair } from "./prompt";
import { LocationAnswerSchema, type LocationAnswerValue } from "./schema";

/** Pairs resolved per daily-path call. A digest step must finish inside the 300 s function limit: with
 *  SYNC_CONCURRENCY requests in flight and the transport's ~60 s deadline on each, 30 take at most ~3 min. */
export const SYNC_CHUNK = 30;
const SYNC_CONCURRENCY = 10;
/** A call where every request failed transiently means the provider is down, but only past a few
 *  requests: one or two pairs that keep failing must not fail every run. */
const OUTAGE_MIN_REQUESTS = 3;

export interface ResolveCounts {
  /** Pairs stored with a checked answer. */
  resolved: number;
  /** Pairs stored as unresolved: a deterministic no-answer. */
  unanswered: number;
  /** Pairs left without a row: the request failed transiently, so a later run asks again. */
  failed: number;
  /** Places the model named that failed the GeoNames check, across the stored pairs. */
  unmatchedPlaces: number;
}

export interface SyncResult extends ResolveCounts {
  /** True when the call hit its chunk size, so more pairs may be waiting. */
  more: boolean;
  /** The pairs that failed transiently, for the caller's later calls in the same run to skip. */
  failedPairs: LocationPairKey[];
}

/** One pair's outcome, for the CLIs' failure listings. */
export interface PairOutcome {
  pair: LocationPair;
  row: LocationStringRow | null;
  /** Why a pair has no answer (no row, or an unresolved row). */
  problem?: string;
}

/** One provider batch of a backfill: stored, or failed (its submit, its wait, or the batch itself). */
export interface BatchOutcome {
  /** Null when the submit failed. */
  batchId: string | null;
  pairs: number;
  error?: string;
}

/**
 * The daily path: resolve up to `limit` active pairs that have no row yet, most-listed first, skipping
 * `exclude` (the pairs that already failed earlier in the same run). Each answer is stored as soon as it
 * comes back, so a call cut off by its time limit and retried doesn't pay for those pairs again. Throws
 * only when the provider is clearly down (every request of the call failed transiently); a transient
 * failure otherwise stores nothing and is counted, for the next run to ask again.
 */
export async function syncLocationStrings(
  db: Db,
  model: LocationModel,
  opts: { limit?: number; gazetteer?: Gazetteer; exclude?: LocationPairKey[] } = {},
): Promise<SyncResult> {
  const limit = opts.limit ?? SYNC_CHUNK;
  const pairs = await listPendingPairs(db, {
    scope: "missing",
    promptVersion: PROMPT_VERSION,
    limit,
    exclude: opts.exclude,
  });
  if (pairs.length === 0) return { ...countOutcomes([]), more: false, failedPairs: [] };
  const gazetteer = opts.gazetteer ?? (await loadGazetteer(db));
  const requests = await buildRequests(db, pairs);
  const outcomes = await mapConcurrent(
    pairs.map((pair, i) => ({ pair, request: requests[i]! })),
    SYNC_CONCURRENCY,
    async ({ pair, request }) =>
      (await storeAnswers(db, gazetteer, [pair], [await model.generate(request)]))[0]!,
  );
  const failed = outcomes.filter((o) => !o.row);
  if (failed.length === outcomes.length && outcomes.length >= OUTAGE_MIN_REQUESTS) {
    throw new Error(
      `The location model is unavailable: all ${outcomes.length} requests failed (${failed[0]!.problem}).`,
    );
  }
  return {
    ...countOutcomes(outcomes),
    more: pairs.length === limit,
    failedPairs: failed.map(({ pair }) => ({ companyId: pair.companyId, raw: pair.raw })),
  };
}

/**
 * The backfill: every active pair with no row, a row from another prompt version, or an unresolved row,
 * as provider batches of {@link BATCH_SIZE} submitted together. Each batch's answers are stored as soon as
 * it ends; a batch that fails (its submit, its wait, or the batch itself) leaves its pairs for the next
 * run and never costs the others. `onSubmitted` gets every batch id as it is submitted, for
 * {@link collectLocationBatch} to pick up if this process doesn't live to collect it.
 */
export async function backfillLocationStrings(
  db: Db,
  model: LocationModel,
  opts: { onSubmitted?: (batchId: string, pairs: number) => void } = {},
): Promise<{ counts: ResolveCounts; outcomes: PairOutcome[]; batches: BatchOutcome[] }> {
  const pairs = await listPendingPairs(db, { scope: "stale", promptVersion: PROMPT_VERSION });
  if (pairs.length === 0) return { counts: countOutcomes([]), outcomes: [], batches: [] };
  const gazetteer = await loadGazetteer(db);
  const requests = await buildRequests(db, pairs);
  const byId = new Map(requests.map((r, i) => [r.id, pairs[i]!]));
  const chunks: LocationRequest[][] = [];
  for (let i = 0; i < requests.length; i += BATCH_SIZE)
    chunks.push(requests.slice(i, i + BATCH_SIZE));

  const outcomes: PairOutcome[] = [];
  const batches = await Promise.all(
    chunks.map(async (chunk): Promise<BatchOutcome> => {
      let batchId: string | null = null;
      try {
        batchId = await model.submitBatch(chunk);
        opts.onSubmitted?.(batchId, chunk.length);
        outcomes.push(
          ...(await collectAndStore(
            db,
            gazetteer,
            model,
            batchId,
            byId,
            chunk.map((r) => r.id),
          )),
        );
        return { batchId, pairs: chunk.length };
      } catch (error) {
        return { batchId, pairs: chunk.length, error: errorSummary(error) };
      }
    }),
  );
  return { counts: countOutcomes(outcomes), outcomes, batches };
}

/**
 * Store the answers of a batch an earlier backfill submitted (its id printed at submit), without
 * submitting anything. Only answers for pairs still pending under this prompt version are stored; the
 * rest are counted as `skipped`.
 */
export async function collectLocationBatch(
  db: Db,
  model: LocationModel,
  batchId: string,
): Promise<{ counts: ResolveCounts; outcomes: PairOutcome[]; skipped: number }> {
  const pairs = await listPendingPairs(db, { scope: "stale", promptVersion: PROMPT_VERSION });
  const byId = new Map(pairs.map((p) => [requestId(p), p]));
  const answers = await model.collectBatch(batchId);
  const outcomes = await storeBatchAnswers(db, await loadGazetteer(db), answers, byId, []);
  const skipped = [...answers.keys()].filter((id) => !byId.has(id)).length;
  return { counts: countOutcomes(outcomes), outcomes, skipped };
}

async function collectAndStore(
  db: Db,
  gazetteer: Gazetteer,
  model: LocationModel,
  batchId: string,
  byId: ReadonlyMap<string, LocationPair>,
  ids: string[],
): Promise<PairOutcome[]> {
  const answers = await model.collectBatch(batchId);
  return storeBatchAnswers(db, gazetteer, answers, byId, ids);
}

/** Store a batch's answers for the pairs in `byId`; an id in `expected` with no answer is a failure. */
async function storeBatchAnswers(
  db: Db,
  gazetteer: Gazetteer,
  answers: ReadonlyMap<string, LocationAnswer>,
  byId: ReadonlyMap<string, LocationPair>,
  expected: string[],
): Promise<PairOutcome[]> {
  const pairs: LocationPair[] = [];
  const list: LocationAnswer[] = [];
  for (const [id, answer] of answers) {
    const pair = byId.get(id);
    if (!pair) continue;
    pairs.push(pair);
    list.push(answer);
  }
  for (const id of expected) {
    if (answers.has(id)) continue;
    pairs.push(byId.get(id)!);
    list.push({ status: "failed", reason: "missing from the batch results" });
  }
  return storeAnswers(db, gazetteer, pairs, list);
}

/** A request id that names its pair and prompt version, so a batch's results map back to their pairs in a
 *  later process: `v<version>-<company id>-<hash of the text>` (the Batch API's id pattern, ≤ 64 chars). */
export function requestId(pair: LocationPairKey): string {
  const hash = createHash("sha256").update(pair.raw).digest("hex").slice(0, 32);
  return `v${PROMPT_VERSION.replace(/[^a-zA-Z0-9]/g, "_")}-${pair.companyId}-${hash}`;
}

/** The requests for a set of pairs, each with up to {@link SIBLING_CONTEXT} of its company's other strings. */
async function buildRequests(db: Db, pairs: LocationPair[]): Promise<LocationRequest[]> {
  const companyIds = [...new Set(pairs.map((p) => p.companyId))];
  const strings = await listCompanyStrings(db, companyIds, SIBLING_CONTEXT + 1);
  return pairs.map((pair) =>
    buildLocationRequest(requestId(pair), {
      raw: pair.raw,
      company: {
        slug: pair.companySlug,
        source: pair.companySource,
        otherStrings: (strings.get(pair.companyId) ?? [])
          .filter((s) => s !== pair.raw)
          .slice(0, SIBLING_CONTEXT),
      },
    } satisfies PromptPair),
  );
}

/** Check and store the answers; `failed` answers get no row. */
async function storeAnswers(
  db: Db,
  gazetteer: Gazetteer,
  pairs: LocationPair[],
  answers: LocationAnswer[],
): Promise<PairOutcome[]> {
  const parsed = answers.map(parseAnswer);
  const valid = parsed
    .filter((p): p is { value: LocationAnswerValue } => "value" in p)
    .map((p) => p.value);
  const checked = await checkAnswers(db, gazetteer, valid);
  let next = 0;
  const outcomes = pairs.map((pair, i): PairOutcome => {
    const p = parsed[i]!;
    if ("failed" in p) return { pair, row: null, problem: p.failed };
    if ("unanswered" in p) {
      return {
        pair,
        row: unresolvedRow(pair, p.unanswered),
        problem: p.unanswered,
      };
    }
    const check = checked[next++]!;
    return {
      pair,
      row: {
        companyId: pair.companyId,
        raw: pair.raw,
        placeIds: check.placeIds,
        remoteCountries: check.remoteCountries,
        unmatched: check.unmatched,
        confidence: p.value.confidence,
        reason: p.value.reason.trim().slice(0, 500),
        promptVersion: PROMPT_VERSION,
      },
    };
  });
  await upsertLocationStrings(
    db,
    outcomes.flatMap((o) => (o.row ? [o.row] : [])),
  );
  return outcomes;
}

/** Validate a reply against the answer schema. A reply that isn't schema-valid JSON is no answer. */
export function parseAnswer(
  answer: LocationAnswer,
): { value: LocationAnswerValue } | { unanswered: string } | { failed: string } {
  if (answer.status === "failed") return { failed: answer.reason };
  if (answer.status === "no-answer") return { unanswered: answer.reason };
  let json: unknown;
  try {
    json = JSON.parse(answer.text);
  } catch {
    return { unanswered: "the reply was not JSON" };
  }
  const result = LocationAnswerSchema.safeParse(json);
  return result.success
    ? { value: result.data }
    : { unanswered: "the reply did not match the schema" };
}

function unresolvedRow(pair: LocationPair, why: string): LocationStringRow {
  return {
    companyId: pair.companyId,
    raw: pair.raw,
    placeIds: [],
    remoteCountries: [],
    unmatched: [],
    confidence: null,
    reason: `not resolved: ${why}`.slice(0, 500),
    promptVersion: PROMPT_VERSION,
  };
}

function countOutcomes(outcomes: PairOutcome[]): ResolveCounts {
  const counts: ResolveCounts = { resolved: 0, unanswered: 0, failed: 0, unmatchedPlaces: 0 };
  for (const o of outcomes) {
    if (!o.row) counts.failed++;
    else if (o.row.confidence === null) counts.unanswered++;
    else counts.resolved++;
    counts.unmatchedPlaces += o.row?.unmatched.length ?? 0;
  }
  return counts;
}

/** An error's class and message, capped: the transport's errors carry no request or response body. */
function errorSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "error";
}

/** Map with at most `limit` calls in flight; results keep the input order. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
