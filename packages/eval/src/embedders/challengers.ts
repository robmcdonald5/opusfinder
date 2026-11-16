/**
 * The challenger models of the embedding head-to-head, each on ONE pinned host that neither trains on
 * nor keeps inputs. Both hosts speak the OpenAI embeddings shape, so one request function serves them.
 *
 *  - Qwen3-Embedding-8B goes through OpenRouter, pinned to DeepInfra with fallbacks off and only
 *    zero-retention, no-data-collection endpoints allowed: the request reaches that host or fails, and
 *    the response names the host that served it, which is checked on every request. DeepInfra doesn't
 *    state its serving precision for this model. Nebius does (bf16), but OpenRouter's shared token
 *    quota there refused a bulk run after 322k tokens (2026-11-16); DeepInfra carried ~2.5M a minute.
 *  - Nemotron-3-Embed-8B goes to DeepInfra directly. OpenRouter lists it only as NVIDIA's free trial
 *    endpoint, whose terms allow NVIDIA to improve its models with what is sent.
 *
 * These endpoints take no query/document hint, so each side's presentation is applied HERE, to the
 * text, as the model's card documents it. A pool builder embedding profiles must call
 * `embedBatch(..., "query")` so both sides of a comparison match the stored job vectors.
 */
import { EmbeddingRejectedError, parseEmbeddingResponse } from "@opusfinder/embeddings";
import { isRecord } from "@opusfinder/shared";

import { getDeepInfraApiKey, getOpenRouterApiKey } from "../snapshot/env";
import type {
  MeteredEmbeddings,
  SnapshotInputType,
  SnapshotModel,
  SnapshotModelSlug,
} from "./snapshot-models";

// A 32-text request returns ~1.5 MB of JSON at 4096 dims; it normally answers in seconds.
const REQUEST_TIMEOUT_MS = 120_000;

/** The task a profile query is given on Qwen3 (its card: one English sentence, on the query side
 *  only). Part of the measured setup: changing it changes every Qwen query vector. */
export const QWEN_QUERY_TASK =
  "Given a job seeker's resume, retrieve job postings that are a good fit for them";

/** Qwen3-Embedding's query template, verbatim from the model card (no space after "Query:"). */
export function qwenQueryText(query: string): string {
  return `Instruct: ${QWEN_QUERY_TASK}\nQuery:${query}`;
}

/** Nemotron-3-Embed's prefixes, verbatim from the model card. */
export const NEMOTRON_PREFIX: Record<SnapshotInputType, string> = {
  document: "passage: ",
  query: "query: ",
};

interface ChallengerSpec {
  /** The model's canonical id: what is stored beside its vectors. */
  id: string;
  host: string;
  url: string;
  getApiKey: () => string;
  /** The request body around `input`: the host's name for the model, plus any routing pin. */
  body: Record<string, unknown>;
  /** OpenRouter names the provider that served a request; when set, any other answer is refused. */
  servedBy?: string;
  dimensions: number;
  pricePerMTokUsd: number;
  present: (text: string, inputType: SnapshotInputType) => string;
  presentation: SnapshotModel["presentation"];
}

export type ChallengerSlug = Exclude<SnapshotModelSlug, "voyage-4-large">;

const SPECS: Record<ChallengerSlug, ChallengerSpec> = {
  "qwen3-embedding-8b": {
    id: "Qwen/Qwen3-Embedding-8B",
    host: "openrouter.ai -> DeepInfra",
    url: "https://openrouter.ai/api/v1/embeddings",
    getApiKey: getOpenRouterApiKey,
    body: {
      model: "qwen/qwen3-embedding-8b",
      provider: { only: ["deepinfra"], allow_fallbacks: false, data_collection: "deny", zdr: true },
    },
    servedBy: "DeepInfra",
    dimensions: 4096,
    pricePerMTokUsd: 0.01,
    present: (text, inputType) => (inputType === "query" ? qwenQueryText(text) : text),
    presentation: {
      document: "the text as it is (no instruction)",
      query: `"Instruct: ${QWEN_QUERY_TASK}\\nQuery:" before the text`,
    },
  },
  "nemotron-3-embed-8b": {
    id: "nvidia/Nemotron-3-Embed-8B",
    host: "api.deepinfra.com",
    url: "https://api.deepinfra.com/v1/openai/embeddings",
    getApiKey: getDeepInfraApiKey,
    body: { model: "nvidia/Nemotron-3-Embed-8B" },
    dimensions: 4096,
    pricePerMTokUsd: 0.035,
    present: (text, inputType) => `${NEMOTRON_PREFIX[inputType]}${text}`,
    presentation: {
      document: `"${NEMOTRON_PREFIX.document}" before the text`,
      query: `"${NEMOTRON_PREFIX.query}" before the text`,
    },
  },
};

export function challengerModel(slug: ChallengerSlug): SnapshotModel {
  const spec = SPECS[slug];
  return {
    id: spec.id,
    slug,
    role: "challenger",
    host: spec.host,
    dimensions: spec.dimensions,
    pricePerMTokUsd: spec.pricePerMTokUsd,
    // Neither host publishes a per-request item cap; 32 texts keeps a response near 1.5 MB.
    limits: { maxItems: 32, maxTokens: 60_000, charsPerToken: 3 },
    presentation: spec.presentation,
    embedBatch: (texts, inputType) =>
      embedRequest(
        spec,
        texts.map((text) => spec.present(text, inputType)),
      ),
  };
}

/** One request, with the text exactly as given (no presentation added). Exported for the host probe. */
export async function embedRequest(
  spec: ChallengerSpec,
  input: string[],
): Promise<MeteredEmbeddings> {
  const res = await fetch(spec.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${spec.getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...spec.body, input, encoding_format: "float" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    // The body is read for a diagnostic snippet (error payloads don't echo the key) and to drain the
    // stream. A 4xx other than 408/429 fails the same way on a retry, so it is marked rejected.
    const snippet = await res.text().catch(() => "");
    const message =
      `${spec.host} embeddings request failed: ${res.status} ${res.statusText}` +
      (snippet ? ` - ${snippet.slice(0, 300)}` : "");
    const rejected = res.status < 500 && res.status !== 408 && res.status !== 429;
    throw rejected ? new EmbeddingRejectedError(message) : new Error(message);
  }

  const body = (await res.json()) as unknown;
  if (spec.servedBy !== undefined) {
    const provider = isRecord(body) ? body.provider : undefined;
    if (provider !== spec.servedBy) {
      throw new EmbeddingRejectedError(
        `${spec.host}: expected ${spec.servedBy} to serve the request, got ${JSON.stringify(provider)}.`,
      );
    }
  }
  const parsed = parseEmbeddingResponse(body, {
    provider: spec.host,
    expectedDimensions: spec.dimensions,
    expectedCount: input.length,
  });
  // The spend guard meters on this, so a response without usage can't pass as free.
  if (parsed.totalTokens <= 0) {
    throw new EmbeddingRejectedError(`${spec.host} embeddings response reported no token usage.`);
  }
  // OpenRouter reports what the request cost; a host's pricier tier would show up here.
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : undefined;
  const costUsd =
    typeof usage?.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : undefined;
  return { ...parsed, costUsd };
}

/** A challenger's host settings, for the probe. */
export function challengerSpec(slug: ChallengerSlug): ChallengerSpec {
  return SPECS[slug];
}
