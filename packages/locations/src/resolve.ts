/**
 * Resolve (company, raw) location pairs into `location_strings` rows: build the requests, ask the model,
 * check its answers against GeoNames, store them. Two entry points over the same request builder and the
 * same answer handling: {@link syncLocationStrings}, the daily path (pairs with no row yet, a few
 * requests at a time, run by the digest before its fan-out and by `locations:sync`), and
 * {@link backfillLocationStrings}, one provider batch over every missing, stale or unanswered pair
 * (`locations:backfill`).
 */
import type { Db } from "@opusfinder/db";
import {
  listCompanyStrings,
  listPendingPairs,
  upsertLocationStrings,
  type LocationPair,
  type LocationStringRow,
} from "@opusfinder/db/repos";
import { backoff } from "@opusfinder/shared/async";

import { checkAnswers, loadGazetteer, type Gazetteer } from "./check";
import {
  buildLocationRequest,
  type LocationAnswer,
  type LocationModel,
  type LocationRequest,
} from "./model";
import { PROMPT_VERSION, SIBLING_CONTEXT, type PromptPair } from "./prompt";
import { LocationAnswerSchema, type LocationAnswerValue } from "./schema";

/** Pairs resolved per daily-path call: a digest step must finish well inside the 300 s function limit. */
export const SYNC_CHUNK = 40;
const SYNC_CONCURRENCY = 5;
/** Attempts per request on the daily path, on top of the transport's own retries. */
const GENERATE_ATTEMPTS = 3;

export interface ResolveCounts {
  /** Pairs stored with a checked answer. */
  resolved: number;
  /** Pairs stored as unresolved: the model gave no usable answer. */
  unanswered: number;
  /** Pairs left without a row: the request never completed (batch only). */
  failed: number;
  /** Places the model named that failed the GeoNames check, across the stored pairs. */
  unmatchedPlaces: number;
}

export interface SyncResult extends ResolveCounts {
  /** True when the call hit its chunk size, so more pairs may be waiting. */
  more: boolean;
}

/** One pair's outcome, for the CLIs' failure listings. */
export interface PairOutcome {
  pair: LocationPair;
  row: LocationStringRow | null;
  /** Why a pair has no answer (no row, or an unresolved row). */
  problem?: string;
}

/**
 * The daily path: resolve up to `limit` active pairs that have no row yet, most-listed first. A request
 * that keeps failing throws (after retries), so the caller's run fails visibly instead of filtering on
 * strings nobody resolved; whatever was stored before the throw stays stored.
 */
export async function syncLocationStrings(
  db: Db,
  model: LocationModel,
  opts: { limit?: number; gazetteer?: Gazetteer } = {},
): Promise<SyncResult> {
  const limit = opts.limit ?? SYNC_CHUNK;
  const pairs = await listPendingPairs(db, {
    scope: "missing",
    promptVersion: PROMPT_VERSION,
    limit,
  });
  if (pairs.length === 0)
    return { resolved: 0, unanswered: 0, failed: 0, unmatchedPlaces: 0, more: false };
  const gazetteer = opts.gazetteer ?? (await loadGazetteer(db));
  const requests = await buildRequests(db, pairs);
  const answers = await mapConcurrent(requests, SYNC_CONCURRENCY, (r) =>
    generateWithRetries(model, r),
  );
  const outcomes = await storeAnswers(db, gazetteer, pairs, answers);
  return { ...countOutcomes(outcomes), more: pairs.length === limit };
}

/**
 * The backfill: every active pair with no row, a row from another prompt version, or an unresolved row,
 * as ONE provider batch. Returns every pair's outcome so the CLI can list the unresolved ones.
 */
export async function backfillLocationStrings(
  db: Db,
  model: LocationModel,
): Promise<{ counts: ResolveCounts; outcomes: PairOutcome[] }> {
  const pairs = await listPendingPairs(db, { scope: "stale", promptVersion: PROMPT_VERSION });
  if (pairs.length === 0) return { counts: countOutcomes([]), outcomes: [] };
  const gazetteer = await loadGazetteer(db);
  const requests = await buildRequests(db, pairs);
  const results = await model.batch(requests);
  const answers = requests.map(
    (r): LocationAnswer =>
      results.get(r.id) ?? { status: "failed", reason: "missing from the batch results" },
  );
  const outcomes = await storeAnswers(db, gazetteer, pairs, answers);
  return { counts: countOutcomes(outcomes), outcomes };
}

/** The requests for a set of pairs, each with up to {@link SIBLING_CONTEXT} of its company's other strings. */
async function buildRequests(db: Db, pairs: LocationPair[]): Promise<LocationRequest[]> {
  const companyIds = [...new Set(pairs.map((p) => p.companyId))];
  const strings = await listCompanyStrings(db, companyIds, SIBLING_CONTEXT + 1);
  return pairs.map((pair, i) =>
    buildLocationRequest(`p${i}`, {
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

async function generateWithRetries(
  model: LocationModel,
  request: LocationRequest,
): Promise<LocationAnswer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await model.generate(request);
    } catch (err) {
      if (attempt + 1 >= GENERATE_ATTEMPTS) throw err;
      await backoff(attempt);
    }
  }
}

/** Map with at most `limit` calls in flight; results keep the input order. After a call throws, no new
 *  call starts, and the first error is what rejects. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (next < items.length && !stopped) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!);
      } catch (err) {
        stopped = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
