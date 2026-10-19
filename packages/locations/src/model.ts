/**
 * The seam between the normalizer and an LLM transport: one structured call and one batch call, both
 * fed by {@link buildLocationRequest}, so the daily path and the backfill send the same prompt, schema and
 * settings. The transport (packages/llm) owns the provider, retries of its own, prompt caching of
 * `system`, and the mapping of `effort`/`thinking` onto the provider's parameters; nothing here knows the
 * provider.
 */
import { LOCATION_SYSTEM, renderPair, type PromptPair } from "./prompt";
import { LocationAnswerSchema } from "./schema";

/** Output budget: the longest strings name ~20 cities, ~40 tokens each, plus the reason. */
const MAX_OUTPUT_TOKENS = 1024;

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
 * reply with nothing usable in it (a refusal, output cut off at the token cap); the pair is stored as
 * unresolved. `failed` means the request never completed (a batch request that errored or expired); the
 * pair is left without a row for a later run.
 */
export type LocationAnswer =
  | { status: "answered"; text: string }
  | { status: "no-answer"; reason: string }
  | { status: "failed"; reason: string };

export interface LocationModel {
  /** One request, answered now. A reply with nothing usable in it (refused, cut off, off-schema) returns
   *  `no-answer` and never throws; it throws only when the request itself fails (network, auth, rate
   *  limit, server error) once the transport's retries are spent. */
  generate(request: LocationRequest): Promise<Exclude<LocationAnswer, { status: "failed" }>>;
  /** Many requests as one provider batch, waited to completion. Every request id is in the result. */
  batch(requests: LocationRequest[]): Promise<Map<string, LocationAnswer>>;
}

export function buildLocationRequest(id: string, pair: PromptPair): LocationRequest {
  return {
    id,
    system: LOCATION_SYSTEM,
    user: renderPair(pair),
    schema: LocationAnswerSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    effort: "low",
    thinking: "off",
  };
}
