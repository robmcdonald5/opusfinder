import type { z } from "zod";

import { sleep } from "@opusfinder/shared/async";

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import {
  buildMessagesBody,
  readMessage,
  type CallOptions,
  type MessagesBody,
  type MessagesResponse,
  type StopReason,
} from "./messages";
import { openRouterRequest } from "./openrouter";
import { modelId } from "./provider";

/**
 * OpenRouter's Batch API (`/batches`, about half the per-token price) — the cost lever for digest synthesis.
 * Each request's body is the same Anthropic Messages body the sync calls send (`endpoint: "/v1/messages"`).
 * Two layers:
 *
 *   - Low-level primitives — {@link submitBatch} / {@link pollBatch} / {@link collectBatchResults} —
 *     for a DURABLE caller (the Inngest digest function drives them across `step.run` + `step.sleep`,
 *     so the hours-long batch wait suspends at zero compute cost).
 *   - {@link batchGenerate} — a blocking submit→poll→collect convenience composing the primitives, for
 *     a non-durable caller (only the `test:batch` live smoke uses it).
 *
 * NODE-only by design — the digest is Node-hosted and `guard:worker` keeps this package out of the scraper
 * Worker. The Batch API rejects some sync-only settings at validation, which fails the WHOLE batch after
 * the submit returned: Sonnet's thinking-off spelling and inline file bytes are refused here, at submit.
 */

/** One request in a batch: the same {@link CallOptions} a sync call takes, plus a caller-supplied
 *  `customId` to correlate results (`^[a-zA-Z0-9_-]{1,64}$`) and an optional `schema` to constrain the
 *  reply to JSON (parse the result's `text` with `parseObject`). Every request in a batch must use the same
 *  model tier. A cached system prompt gets a 1-hour TTL: a batch runs minutes to hours, and requests in one
 *  batch run concurrently, so a cache written by one is not reliably read by another. */
export interface BatchRequest extends CallOptions {
  customId: string;
  schema?: z.ZodType<unknown>;
}

/** A request's outcome. `errored` covers a per-request failure; a batch that failed, expired or was
 *  cancelled as a whole makes {@link collectBatchResults} throw instead. */
export type BatchResultStatus = "succeeded" | "errored";

/** Per-request token usage, present on a succeeded result. OpenRouter reports cost only for the whole
 *  batch ({@link BatchCollection.costUsd}). */
export interface BatchUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** One batch result, correlated back to its request by `customId`. `text` is the completion on success
 *  ("" otherwise). `stopReason` is set on success only: anything but `end_turn` / `stop_sequence` (e.g.
 *  `max_tokens`, `refusal`) means `text` is not a complete answer. `error` is a SECRET-free error type. */
export interface BatchResult {
  customId: string;
  status: BatchResultStatus;
  text: string;
  stopReason?: StopReason | null;
  error?: string;
  usage?: BatchUsage;
}

/** OpenRouter's batch lifecycle states. */
export type BatchState =
  | "validating"
  | "in_progress"
  | "finalizing"
  | "completed"
  | "failed"
  | "expired"
  | "cancelling"
  | "cancelled";

export interface BatchPoll {
  /** `ended` once the batch reached a terminal state (completed, failed, expired, cancelled). */
  status: "in_progress" | "ended";
  state: BatchState;
  counts: { total: number; completed: number; failed: number };
}

/** A finished batch's results by `customId`, plus the batch's total charge as OpenRouter reports it. */
export interface BatchCollection {
  results: Map<string, BatchResult>;
  costUsd: number;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const CUSTOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const TERMINAL: ReadonlySet<BatchState> = new Set(["completed", "failed", "expired", "cancelled"]);

interface WireBatch {
  id: string;
  status: BatchState;
  request_counts?: { total?: number; completed?: number; failed?: number };
  usage?: { cost?: unknown } | null;
  error?: { message?: string } | null;
  results?: WireResult[] | null;
}

interface WireResult {
  custom_id: string;
  response?: { status_code?: number; body?: MessagesResponse } | null;
  error?: { type?: string; error_type?: string } | null;
}

function assertRequests(requests: BatchRequest[]): void {
  const seen = new Set<string>();
  for (const r of requests) {
    if (!CUSTOM_ID_PATTERN.test(r.customId)) {
      throw new Error(
        `submitBatch: customId "${r.customId}" must match ${CUSTOM_ID_PATTERN.source}.`,
      );
    }
    // Duplicates would be rejected by the API AND collapse the customId->result map, mis-correlating one
    // request's result onto another — fail fast and clearly here instead.
    if (seen.has(r.customId)) {
      throw new Error(
        `submitBatch: duplicate customId "${r.customId}" (must be unique within a batch).`,
      );
    }
    seen.add(r.customId);
  }
  const tiers = new Set(requests.map((r) => r.model));
  if (tiers.size > 1) {
    throw new Error(`submitBatch: a batch runs one model; got ${[...tiers].join(", ")}.`);
  }
}

function toBody(req: BatchRequest): MessagesBody {
  const format = req.schema ? zodOutputFormat(req.schema) : undefined;
  return buildMessagesBody("submitBatch", req, {
    defaultMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    cacheTtl: "1h",
    inBatch: true,
    ...(format ? { format: { type: format.type, schema: format.schema } } : {}),
  });
}

/**
 * Submit a batch and return its id. Throws on an empty list, a malformed or duplicate customId, mixed
 * model tiers, or a setting the Batch API would reject. Does NOT wait — pair with {@link pollBatch} +
 * {@link collectBatchResults} (durable callers) or use {@link batchGenerate} (blocking).
 */
export async function submitBatch(requests: BatchRequest[]): Promise<string> {
  const first = requests[0];
  if (!first) throw new Error("submitBatch: received no requests.");
  assertRequests(requests);
  const bodies = requests.map((req) => ({ custom_id: req.customId, body: toBody(req) }));
  // `endpoint`, `model` and `provider` must serialize before `requests`: the API stream-parses the body.
  // Pinned to Anthropic: OpenRouter otherwise picks the cheapest batch endpoint, and another provider
  // can take up to 96h (past the digest's ~24h poll window) or reject a field that fails the whole batch.
  // One attempt: a retried submit whose first try reached the server would create a second paid batch.
  const batch = await openRouterRequest<WireBatch>(
    "POST",
    "/batches",
    {
      endpoint: "/v1/messages",
      model: modelId(first.model),
      provider: { only: ["anthropic"] },
      requests: bodies,
    },
    { maxRetries: 0 },
  );
  return batch.id;
}

/** A batch that reached a terminal state other than `completed`: OpenRouter returns no results for it,
 *  and reading it again won't change that. */
export class BatchEndedError extends Error {
  readonly state: BatchState;
  constructor(batchId: string, state: BatchState, reason: string | undefined) {
    super(
      `collectBatchResults: batch ${batchId} is ${state}, not completed${reason ? `: ${reason.slice(0, 300)}` : ""}`,
    );
    this.name = "BatchEndedError";
    this.state = state;
  }
}

/** Poll a batch's state and request counts. `status === "ended"` means it reached a terminal state and
 *  {@link collectBatchResults} can be read. Idempotent. A batch polled within seconds of its submit can
 *  404 (`OpenRouterError`), so wait before the first poll (the digest sleeps 30s). */
export async function pollBatch(batchId: string): Promise<BatchPoll> {
  const batch = await getBatch(batchId);
  return {
    status: TERMINAL.has(batch.status) ? "ended" : "in_progress",
    state: batch.status,
    counts: {
      total: batch.request_counts?.total ?? 0,
      completed: batch.request_counts?.completed ?? 0,
      failed: batch.request_counts?.failed ?? 0,
    },
  };
}

/** Read a completed batch's inline results into a `customId → BatchResult` map. Throws
 *  {@link BatchEndedError} when the batch failed, expired or was cancelled as a whole (OpenRouter then
 *  returns no results), naming the state and its reason. */
export async function collectBatchResults(batchId: string): Promise<BatchCollection> {
  const batch = await getBatch(batchId);
  if (batch.status !== "completed") {
    throw new BatchEndedError(batchId, batch.status, batch.error?.message);
  }
  const results = new Map<string, BatchResult>();
  for (const r of batch.results ?? []) results.set(r.custom_id, mapResult(r));
  return { results, costUsd: count(batch.usage?.cost) };
}

function getBatch(batchId: string): Promise<WireBatch> {
  return openRouterRequest<WireBatch>("GET", `/batches/${encodeURIComponent(batchId)}`);
}

function mapResult(r: WireResult): BatchResult {
  const body = r.response?.body;
  if (r.response?.status_code === 200 && body) {
    const reply = readMessage(body);
    return {
      customId: r.custom_id,
      status: "succeeded",
      text: reply.text,
      stopReason: reply.stopReason,
      usage: {
        inputTokens: reply.usage.inputTokens,
        outputTokens: reply.usage.outputTokens,
        cacheCreationInputTokens: reply.cache.creationInputTokens,
        cacheReadInputTokens: reply.cache.readInputTokens,
      },
    };
  }
  // Only the error TYPE is surfaced (SECRET-free), never its message or a body.
  const errorType =
    r.error?.error_type ?? r.error?.type ?? `http_${r.response?.status_code ?? "unknown"}`;
  return { customId: r.custom_id, status: "errored", text: "", error: errorType };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface BatchGenerateOptions {
  /** Poll interval while waiting for the batch to end (default 10s). */
  pollIntervalMs?: number;
  /** Give up (throw) after this long (default 24h — the completion window). */
  maxWaitMs?: number;
  /** Progress hook, called after each poll. */
  onPoll?: (poll: BatchPoll) => void;
}

/**
 * Blocking batch generation: submit → poll until ended → collect. Returns results in the SAME ORDER as
 * `requests` (a request missing from the results yields an `errored` placeholder). Giving up does not stop
 * the batch — OpenRouter has no cancel endpoint, so its completed requests are still billed; the thrown
 * error carries the batch id. For a DURABLE caller, drive the primitives across Inngest steps instead.
 */
export async function batchGenerate(
  requests: BatchRequest[],
  opts: BatchGenerateOptions = {},
): Promise<{ results: BatchResult[]; costUsd: number }> {
  if (requests.length === 0) return { results: [], costUsd: 0 };
  const batchId = await submitBatch(requests);

  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  const maxWaitMs = opts.maxWaitMs ?? 24 * 60 * 60 * 1000;
  const startedAt = Date.now();
  for (;;) {
    // Wait first: a just-submitted batch can read as 404 for a few seconds.
    await sleep(pollIntervalMs);
    const poll = await pollBatch(batchId);
    opts.onPoll?.(poll);
    if (poll.status === "ended") break;
    if (Date.now() - startedAt > maxWaitMs) {
      throw new Error(
        `batchGenerate: batch ${batchId} did not end within ${maxWaitMs}ms (state ${poll.state}); it keeps ` +
          "running server-side.",
      );
    }
  }

  const { results, costUsd } = await collectBatchResults(batchId);
  return {
    results: requests.map(
      (r) =>
        results.get(r.customId) ?? {
          customId: r.customId,
          status: "errored" as const,
          text: "",
          error: "missing from batch results",
        },
    ),
    costUsd,
  };
}
