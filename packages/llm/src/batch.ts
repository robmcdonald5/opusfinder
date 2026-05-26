import type { ModelMessage } from "ai";

import type { ModelAlias } from "./provider";

/**
 * One request in a batch. Mirrors {@link GenerateParams} inputs plus a caller-supplied
 * `customId` to correlate results (Anthropic returns batch results unordered).
 * Deliberately generic — the llm package stays domain-agnostic; the job-specific
 * shape (e.g. rerank groups) is assembled by the Phase 10 caller, not here.
 */
export interface BatchRequest {
  customId: string;
  model: ModelAlias;
  messages: ModelMessage[];
  system?: string;
  cacheSystem?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
}

/** One batch result, correlated back to its request by `customId`. */
export interface BatchResult {
  customId: string;
  text: string;
}

/**
 * Batch generation against Anthropic's Message Batches API (50% token discount) — the
 * cost lever Phase 10 rerank + synthesis rely on.
 *
 * NOT IMPLEMENTED until Phase 10 — sketched here so the package's surface is known.
 * The Vercel AI SDK has no batch support, so the real implementation will use the raw
 * `@anthropic-ai/sdk` (added as a dependency then):
 *
 *   const client = new Anthropic({ apiKey: getAnthropicApiKey() });
 *   // 1. create: map each BatchRequest -> { custom_id, params: { model, max_tokens, system, messages } }
 *   const batch = await client.messages.batches.create({ requests });
 *   // 2. poll: retrieve until processing_status === "ended" (most finish < 1h, 24h hard cap)
 *   // 3. results: stream the JSONL and map succeeded entries back by custom_id
 *   for await (const entry of await client.messages.batches.results(batch.id)) { ... }
 *
 * Prompt-cache markers (cacheSystem) carry through the per-request params exactly as
 * in generate().
 */
export async function batchGenerate(requests: BatchRequest[]): Promise<BatchResult[]> {
  // `async` so the failure is a promise REJECTION (consistent with the Promise return
  // type), not a synchronous throw that bypasses `.catch()` / `Promise.all`.
  throw new Error(
    `batchGenerate() received ${requests.length} request(s) but is not implemented until ` +
      "Phase 10 (digest pipeline). Use generate() for single calls.",
  );
}
