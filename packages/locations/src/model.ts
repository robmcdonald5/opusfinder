/**
 * The seam between the normalizer and an LLM transport: one structured call, and a provider batch as a
 * submit plus a collect, all fed by {@link buildLocationRequest}, so the daily path and the backfill send
 * the same prompt, schema and settings. The transport (packages/llm) owns the provider, retries of its
 * own, prompt caching of `system`, the mapping of `effort`/`thinking` onto the provider's parameters, and
 * which of its errors are transient; nothing here knows the provider.
 */
import { LOCATION_SYSTEM, renderPair, type PromptPair } from "./prompt";
import { LocationAnswerSchema } from "./schema";

const PLACE_SEPARATORS = /[,;|/&\n]|\b(?:or|and)\b/gi;
const BASE_OUTPUT_TOKENS = 256;
const TOKENS_PER_PART = 48;
const MAX_OUTPUT_TOKENS = 4096;

/**
 * Each request's output budget, sized to the answer its text can need. The provider reserves a request's
 * whole budget against the key's credit until it finishes, and a backfill's batches hold every request's
 * at once, so one flat cap sized for the longest string reserved many times what the answers use. A place
 * in the answer is ~30 tokens and the text separates the places it names (",", ";", "|", "/", "&", "or",
 * "and"): a base for the reason, the JSON frame and a place or two, plus an allowance per separated part,
 * capped for the longest string a job stores (500 characters name at most ~85 places). The busiest golden
 * strings use under half their budget. Sized from the text alone, so a reply cut off at its budget is a
 * deterministic outcome, stored as unresolved.
 */
export function outputBudget(raw: string): number {
  const parts = 1 + (raw.match(PLACE_SEPARATORS) ?? []).length;
  return Math.min(MAX_OUTPUT_TOKENS, BASE_OUTPUT_TOKENS + TOKENS_PER_PART * parts);
}

/** Requests per provider batch. Every request repeats the ~12 KB system block plus ~1 KB of pair and
 *  context, so 1,500 keep a submit near 20 MB; a larger set goes out as several batches. */
export const BATCH_SIZE = 1500;

export interface LocationRequest {
  /** Correlates a batch result with its pair; matches ^[a-zA-Z0-9_-]{1,64}$. */
  id: string;
  /** The stable instructions + worked examples, identical for every request (cacheable). */
  system: string;
  /** The pair's data. */
  user: string;
  /** The schema the answer must follow, sent as the structured-output format. */
  schema: typeof LocationAnswerSchema;
  maxOutputTokens: number;
  /** A short extraction: the lowest effort, and no thinking. */
  effort: "low";
  thinking: "off";
}

/**
 * What came back for one request. `answered` carries the model's text (JSON, per `schema`). `no-answer` is a
 * DETERMINISTIC outcome with nothing usable in it (a refusal, output cut off at the token cap, a reply off
 * the schema, the provider rejecting this request's content); the pair is stored as unresolved, and asking
 * again tomorrow would get the same. `failed` is TRANSIENT (a timeout, rate limit, server or network
 * error, a batch request that errored); the pair is left without a row, so a later run asks again.
 */
export type LocationAnswer =
  | { status: "answered"; text: string }
  | { status: "no-answer"; reason: string }
  | { status: "failed"; reason: string };

export interface LocationModel {
  /** One request, answered within the transport's deadline (about a minute). Never throws for anything
   *  the provider does: its outcomes are the three statuses. */
  generate(request: LocationRequest): Promise<LocationAnswer>;
  /** Submit up to {@link BATCH_SIZE} requests as one provider batch; returns its id at once. */
  submitBatch(requests: LocationRequest[]): Promise<string>;
  /** Wait for a submitted batch to end and read its answers, by request id. Throws when the batch failed,
   *  expired or was cancelled as a whole (no answers to read). */
  collectBatch(batchId: string): Promise<Map<string, LocationAnswer>>;
}

export function buildLocationRequest(id: string, pair: PromptPair): LocationRequest {
  return {
    id,
    system: LOCATION_SYSTEM,
    user: renderPair(pair),
    schema: LocationAnswerSchema,
    maxOutputTokens: outputBudget(pair.raw),
    effort: "low",
    thinking: "off",
  };
}
