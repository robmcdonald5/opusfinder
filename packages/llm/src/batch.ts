import Anthropic from "@anthropic-ai/sdk";
import type { ModelMessage } from "ai";

import { sleep } from "@opusfinder/shared/async";

import { getAnthropicApiKey } from "./env";
import { modelId, type ModelAlias } from "./provider";

/**
 * Anthropic Message Batches API (50% token discount) — the cost lever for digest synthesis.
 * The Vercel AI SDK has NO batch support, so this is the ONE place that talks to the raw
 * `@anthropic-ai/sdk`. Two layers:
 *
 *   - Low-level primitives — {@link submitBatch} / {@link pollBatch} / {@link collectBatchResults} —
 *     for a DURABLE caller (the Inngest digest function drives them across `step.run` + `step.sleep`,
 *     so the hours-long batch wait suspends at zero compute cost).
 *   - {@link batchGenerate} — a blocking submit→poll→collect convenience composing the primitives, for
 *     non-durable callers (the eval harness, the CLI smoke).
 *
 * The API key comes from `getAnthropicApiKey()` (env) and the client is memoized for the process
 * (mirrors provider.ts). NODE-only by design — the digest is Node-hosted and `guard:worker` keeps this
 * package out of the scraper Worker, so there is no keyless-in-Worker path to support.
 */

/** One request in a batch. Mirrors {@link GenerateParams} inputs plus a caller-supplied `customId` to
 *  correlate results (Anthropic returns batch results unordered); `customId` must match
 *  `^[a-zA-Z0-9_-]{1,64}$` (Anthropic's constraint). */
export interface BatchRequest {
  customId: string;
  model: ModelAlias;
  messages: ModelMessage[];
  system?: string;
  /** Cache the system prompt. Sent with a 1-hour TTL (the 5-minute default expires mid-batch — batches
   *  run minutes-to-hours), and only engages above the model's minimum cacheable prefix. Intra-batch
   *  cache hits are best-effort (concurrent processing); verify via {@link BatchResult.usage}. */
  cacheSystem?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
}

export type BatchResultStatus = "succeeded" | "errored" | "expired" | "canceled";

/** Per-request token usage (camelCased off the raw message usage), surfaced so callers can log cache
 *  behavior. Present only on a succeeded result. */
export interface BatchUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** One batch result, correlated back to its request by `customId`. `text` is the completion on success
 *  ("" otherwise); `status` distinguishes success from the per-request failure modes (a batch can
 *  partially fail); `error` carries a SECRET-free error type for non-success. */
export interface BatchResult {
  customId: string;
  status: BatchResultStatus;
  text: string;
  error?: string;
  usage?: BatchUsage;
}

export type BatchProcessingStatus = "in_progress" | "canceling" | "ended";

export interface BatchPoll {
  status: BatchProcessingStatus;
  counts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
}

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const CUSTOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

let memoizedClient: Anthropic | undefined;
function getClient(): Anthropic {
  memoizedClient ??= new Anthropic({ apiKey: getAnthropicApiKey() });
  return memoizedClient;
}

/** Map a BatchRequest's optionally-cached system prompt to the raw shape. Caching promotes the plain
 *  string to a text block carrying `cache_control` with the 1-hour TTL (a plain `system` string can't
 *  carry a breakpoint). Mirrors the cache-promotion in cache-plumbing.ts, but emits the RAW Anthropic
 *  shape (the AI-SDK `providerOptions` form does not apply to this client). */
function buildSystem(system: string, cacheSystem: boolean | undefined): string | Anthropic.TextBlockParam[] {
  if (!cacheSystem) return system;
  return [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }];
}

/** Convert AI-SDK ModelMessages to raw Anthropic messages. Batch synthesis uses user/assistant turns
 *  with string (or text-part) content; image/file/tool parts and system-role messages are rejected with
 *  a clear message (the system prompt belongs in `system`, like generate()). */
function toAnthropicMessages(messages: ModelMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (m.role !== "user" && m.role !== "assistant") {
      throw new Error(
        `batchGenerate: unsupported message role "${m.role}" (only user/assistant; put the system ` +
          "prompt in `system`, not in `messages`).",
      );
    }
    return { role: m.role, content: toContent(m.content) };
  });
}

function toContent(content: string | readonly unknown[]): string | Anthropic.TextBlockParam[] {
  if (typeof content === "string") return content;
  const blocks: Anthropic.TextBlockParam[] = [];
  for (const part of content) {
    const p = part as { type?: unknown; text?: unknown };
    if (p.type === "text" && typeof p.text === "string") {
      blocks.push({ type: "text", text: p.text });
    } else {
      throw new Error(
        `batchGenerate: unsupported content part "${String(p.type)}" (batch synthesis is text-only).`,
      );
    }
  }
  return blocks;
}

function assertCustomIds(requests: BatchRequest[]): void {
  const seen = new Set<string>();
  for (const r of requests) {
    if (!CUSTOM_ID_PATTERN.test(r.customId)) {
      throw new Error(`batchGenerate: customId "${r.customId}" must match ${CUSTOM_ID_PATTERN.source}.`);
    }
    // Duplicates would be rejected by the API (opaque 400) AND collapse the customId->result map,
    // mis-correlating one request's result onto another — fail fast and clearly here instead.
    if (seen.has(r.customId)) {
      throw new Error(`batchGenerate: duplicate customId "${r.customId}" (must be unique within a batch).`);
    }
    seen.add(r.customId);
  }
}

/**
 * Submit a batch and return its id. Maps each {@link BatchRequest} to a raw create-request. Throws on
 * an empty list or a malformed customId. Does NOT wait — pair with {@link pollBatch} +
 * {@link collectBatchResults} (durable callers) or use {@link batchGenerate} (blocking).
 */
export async function submitBatch(requests: BatchRequest[]): Promise<string> {
  if (requests.length === 0) throw new Error("submitBatch: received no requests.");
  assertCustomIds(requests);
  const client = getClient();
  const batch = await client.messages.batches.create({
    requests: requests.map((req) => ({
      custom_id: req.customId,
      params: {
        model: modelId(req.model),
        max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        messages: toAnthropicMessages(req.messages),
        ...(req.system !== undefined ? { system: buildSystem(req.system, req.cacheSystem) } : {}),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      },
    })),
  });
  return batch.id;
}

/** Poll a batch's status + per-status request counts. `status === "ended"` means every request has
 *  settled (any final status) and {@link collectBatchResults} can be read. Idempotent. */
export async function pollBatch(batchId: string): Promise<BatchPoll> {
  const client = getClient();
  const batch = await client.messages.batches.retrieve(batchId);
  const counts = batch.request_counts;
  return {
    status: batch.processing_status,
    counts: {
      processing: counts.processing,
      succeeded: counts.succeeded,
      errored: counts.errored,
      canceled: counts.canceled,
      expired: counts.expired,
    },
  };
}

/** Stream a finished batch's results into a `customId → BatchResult` map. Call only after
 *  {@link pollBatch} reports `ended`. Results arrive unordered, hence the map; a partially-failed batch
 *  yields a mix of statuses. */
export async function collectBatchResults(batchId: string): Promise<Map<string, BatchResult>> {
  const client = getClient();
  const out = new Map<string, BatchResult>();
  for await (const entry of await client.messages.batches.results(batchId)) {
    out.set(entry.custom_id, mapResult(entry.custom_id, entry.result));
  }
  return out;
}

function mapResult(customId: string, result: Anthropic.Messages.MessageBatchResult): BatchResult {
  switch (result.type) {
    case "succeeded":
      return {
        customId,
        status: "succeeded",
        text: extractText(result.message),
        usage: extractUsage(result.message),
      };
    case "errored": {
      // The error envelope nesting has varied across versions ({type} vs {error:{type}}); extract
      // defensively. Only the error TYPE is surfaced (SECRET-free), never a raw body.
      const e = result.error as { type?: unknown; error?: { type?: unknown } };
      const errorType =
        (typeof e.error?.type === "string" && e.error.type) || (typeof e.type === "string" && e.type);
      return { customId, status: "errored", text: "", error: errorType || "errored" };
    }
    case "expired":
      return { customId, status: "expired", text: "", error: "expired" };
    case "canceled":
      return { customId, status: "canceled", text: "", error: "canceled" };
    default: {
      // Exhaustiveness guard: if Anthropic adds a result type, `result` is no longer `never` and this
      // fails to COMPILE (forcing this map to be updated). Unreachable at runtime for the current union;
      // throwing rather than returning undefined keeps the durable collect path from storing a hole.
      const unexpected: never = result;
      throw new Error(`mapResult: unhandled batch result type ${JSON.stringify(unexpected)}.`);
    }
  }
}

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function extractUsage(message: Anthropic.Message): BatchUsage {
  const usage = message.usage;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

export interface BatchGenerateOptions {
  /** Poll interval while waiting for the batch to end (default 10s). */
  pollIntervalMs?: number;
  /** Give up (throw) after this long (default 24h — the API's hard expiry). */
  maxWaitMs?: number;
  /** Progress hook, called after each poll. */
  onPoll?: (poll: BatchPoll) => void;
}

/**
 * Blocking batch generation: submit → poll until ended → collect. Returns results in the SAME ORDER as
 * `requests` (looked up by customId; a request missing from the results — should not happen — yields an
 * `errored` placeholder). For a DURABLE caller, drive {@link submitBatch}/{@link pollBatch}/
 * {@link collectBatchResults} across Inngest steps instead, so the wait suspends at zero compute cost.
 */
export async function batchGenerate(
  requests: BatchRequest[],
  opts: BatchGenerateOptions = {},
): Promise<BatchResult[]> {
  if (requests.length === 0) return [];
  const batchId = await submitBatch(requests);

  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  const maxWaitMs = opts.maxWaitMs ?? 24 * 60 * 60 * 1000;
  const startedAt = Date.now();
  for (;;) {
    const poll = await pollBatch(batchId);
    opts.onPoll?.(poll);
    if (poll.status === "ended") break;
    if (Date.now() - startedAt > maxWaitMs) {
      // Best-effort: stop the server-side batch before abandoning it — every request that completes
      // is billed whether or not anyone collects it. Advisory only; the throw below carries the
      // batchId for manual recovery either way (results are retained 29 days).
      try {
        await getClient().messages.batches.cancel(batchId);
      } catch {
        // the timeout error below is the real signal
      }
      throw new Error(
        `batchGenerate: batch ${batchId} did not end within ${maxWaitMs}ms (status ${poll.status}).`,
      );
    }
    await sleep(pollIntervalMs);
  }

  const byId = await collectBatchResults(batchId);
  return requests.map(
    (r) =>
      byId.get(r.customId) ?? {
        customId: r.customId,
        status: "errored" as const,
        text: "",
        error: "missing from batch results",
      },
  );
}
