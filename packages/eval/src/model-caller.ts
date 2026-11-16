/**
 * The eval's own model caller: one structured-output request to ANY OpenRouter model, on named hosts only.
 * `@opusfinder/llm` speaks the Anthropic Messages API to two Claude tiers; a head-to-head needs the other
 * models too, each on a host and quantisation the test names, so two arms differ by the model and nothing
 * else. Eval-local on purpose: production gets a transport for a non-Anthropic model only if a head-to-head
 * picks one.
 *
 * What a caller cannot switch off: the request runs only on the pinned hosts (no fallback elsewhere), only
 * on a host that honours every parameter sent, and never on one that trains on its inputs. The reply names
 * the host that served it, and a reply from any other host is refused.
 */
import type { z } from "zod";

import { getOpenRouterApiKey } from "@opusfinder/llm/env";
// The Node entry, for its side effect: it loads packages/llm/.env, where the OpenRouter key lives.
import { OpenRouterError } from "@opusfinder/llm/node";
import { backoff } from "@opusfinder/shared/async";

import { toStrictJsonSchema } from "./strict-schema";

const BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 2;
const MESSAGE_MAX = 300;
// OpenRouter's `error_type`s for a failure a later attempt can clear.
const TRANSIENT_ERROR_TYPES: ReadonlySet<string> = new Set([
  "rate_limit_exceeded",
  "provider_overloaded",
  "provider_unavailable",
  "timeout",
  "server",
]);

/** Where one call may run. */
export interface ModelRoute {
  /** OpenRouter model slug, e.g. `deepseek/deepseek-v4.1-flash`. */
  model: string;
  /**
   * The provider slugs the call may run on, tried in this order: a base slug (`deepinfra`) matches every
   * standard endpoint of that provider, a full one (`deepinfra/fp8`) a single endpoint.
   */
  hosts: readonly [string, ...string[]];
  /** Quantisation levels to accept (`fp8`, `bf16`, …). Omitted = whatever the pinned hosts serve. */
  quantizations?: readonly string[];
}

export type ReasoningEffort = "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none";

export interface ModelCallParams<T> {
  route: ModelRoute;
  /** Zod schema for the object: sent as a strict JSON schema (see `toStrictJsonSchema` for what goes
   *  out as a constraint and what is only described), and the reply is validated with it. */
  schema: z.ZodType<T>;
  /** The schema's name on the wire (letters, digits, `_`, `-`). */
  schemaName?: string;
  system?: string;
  /** Mark the system prompt as a prompt-cache breakpoint, for the models that cache explicitly. */
  cacheSystem?: boolean;
  messages: { role: "user" | "assistant"; content: string }[];
  /** Output-token cap; reasoning counts toward it. */
  maxOutputTokens?: number;
  /** Omitted = the model's default. */
  reasoningEffort?: ReasoningEffort;
  /** Omitted = the model's default. A host that doesn't take it is not used. */
  temperature?: number;
  /** Per attempt. */
  timeoutMs?: number;
  /** Extra attempts after a transient failure (network, timeout, 408, 429, 5xx). */
  maxRetries?: number;
  /** OpenRouter API key. Omitted = `OPENROUTER_API_KEY` (packages/llm/.env). */
  apiKey?: string;
}

/** What one reply cost. `inputTokens` counts the whole prompt, cached part included. */
export interface ModelCallUsage {
  inputTokens: number;
  outputTokens: number;
  /** The part of `outputTokens` spent reasoning. */
  reasoningTokens: number;
  /** The part of `inputTokens` read from the prompt cache. */
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** What OpenRouter charged (0 when it reported none). */
  costUsd: number;
}

/** Who answered: the host as OpenRouter names it ("DeepInfra") and the model build it ran. */
export interface Served {
  host: string | null;
  model: string | null;
}

export interface ModelCallResult<T> {
  /** The validated object (conforms to `schema`). */
  object: T;
  usage: ModelCallUsage;
  /** The pinned host that served the reply, as OpenRouter names it. */
  host: string;
  /** The model build that served it, e.g. `anthropic/claude-haiku-5.5-20261007` (null if unreported). */
  servedModel: string | null;
}

export type ReplyFailure =
  /** Cut off at `maxOutputTokens`. */
  | "truncated"
  /** The model or a content filter declined. */
  | "refused"
  /** Stopped for any other reason than a finished answer. */
  | "incomplete"
  /** Not JSON, or not the schema's shape. */
  | "off_schema"
  /** Served by a host outside the route, or by one the reply doesn't name. */
  | "unpinned_host";

/** A reply arrived (and was paid for) but can't be used. `spent` and `served` are that reply's, so a caller
 *  can still count it. Never retried here. Provider and network failures are `OpenRouterError`. */
export class ModelReplyError extends Error {
  readonly reason: ReplyFailure;
  readonly spent: ModelCallUsage;
  readonly served: Served;
  constructor(
    reason: ReplyFailure,
    message: string,
    reply: { spent: ModelCallUsage; served: Served },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelReplyError";
    this.reason = reason;
    this.spent = reply.spent;
    this.served = reply.served;
  }
}

/**
 * Send one structured-output request on the route's hosts and return the validated object with what it
 * cost and who served it. A transient failure is retried with the shared backoff; an unusable reply throws
 * {@link ModelReplyError} at once, because a second paid attempt at the same prompt is the caller's call.
 */
export async function callModel<T>(params: ModelCallParams<T>): Promise<ModelCallResult<T>> {
  const { route } = params;
  if (params.maxOutputTokens !== undefined && params.maxOutputTokens < 1) {
    throw new Error(`callModel(): maxOutputTokens must be >= 1 (got ${params.maxOutputTokens}).`);
  }
  // Before the paid request: a misspelt host fails here, and the reply's host can be checked by name.
  const pinnedNames = await hostNames(route.hosts);
  const schema = toStrictJsonSchema(params.schema);
  const maxOutputTokens = params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  const reply = await postChat(
    {
      model: route.model,
      messages: [
        ...(params.system === undefined ? [] : [systemMessage(params.system, params.cacheSystem)]),
        ...params.messages,
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: params.schemaName ?? "result", strict: true, schema },
      },
      max_completion_tokens: maxOutputTokens,
      ...(params.reasoningEffort ? { reasoning: { effort: params.reasoningEffort } } : {}),
      ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
      // `only` is the hard limit; `order` + no fallbacks makes the pinned hosts the whole attempt list.
      // `require_parameters` refuses a host that would silently drop the schema (or any other field);
      // `data_collection: "deny"` refuses one that stores or trains on its inputs.
      provider: {
        only: route.hosts,
        order: route.hosts,
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: "deny",
        ...(route.quantizations?.length ? { quantizations: route.quantizations } : {}),
      },
    },
    {
      apiKey: params.apiKey || getOpenRouterApiKey(),
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: params.maxRetries ?? DEFAULT_MAX_RETRIES,
    },
  );

  const spent = readUsage(reply.usage);
  const served: Served = { host: servedHost(reply), model: text(reply.model) };
  const fail = (reason: ReplyFailure, message: string, options?: ErrorOptions) =>
    new ModelReplyError(
      reason,
      `callModel(${route.model}): ${message}`,
      { spent, served },
      options,
    );

  if (served.host === null || !pinnedNames.has(served.host)) {
    throw fail(
      "unpinned_host",
      `served by ${served.host ?? "a host the reply does not name"}, not a pinned host ` +
        `(${route.hosts.join(", ")}).`,
    );
  }
  const choice = reply.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw fail("truncated", `output was truncated at maxOutputTokens=${maxOutputTokens}.`);
  }
  if (choice?.finish_reason === "content_filter" || text(choice?.message?.refusal)) {
    throw fail("refused", "the model declined to answer.");
  }
  if (choice?.finish_reason !== "stop") {
    throw fail(
      "incomplete",
      `the model stopped with "${choice?.finish_reason ?? "none"}" instead of an answer.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentText(choice.message?.content));
  } catch {
    // Not the SyntaxError itself: its message quotes the reply.
    throw fail("off_schema", "the reply is not JSON.");
  }
  const checked = params.schema.safeParse(parsed);
  if (!checked.success) {
    // Paths only: an issue's message can quote the reply.
    const paths = [...new Set(checked.error.issues.map((i) => i.path.join(".") || "(root)"))];
    throw fail("off_schema", `the reply does not match the schema (at ${paths.join(", ")}).`);
  }
  return { object: checked.data, usage: spent, host: served.host, servedModel: served.model };
}

function systemMessage(system: string, cache: boolean | undefined) {
  if (!cache) return { role: "system" as const, content: system };
  return {
    role: "system" as const,
    content: [
      { type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } },
    ],
  };
}

/** The fields this module reads off a chat-completions reply. */
interface ChatReply {
  model?: unknown;
  /** Not in OpenRouter's schema, but sent: the serving host's name. */
  provider?: unknown;
  choices?: {
    finish_reason?: unknown;
    message?: { content?: unknown; refusal?: unknown };
    error?: ErrorBody;
  }[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    cost?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } | null;
    completion_tokens_details?: { reasoning_tokens?: unknown } | null;
  };
  /** Present because the request opts in (`X-OpenRouter-Metadata`). */
  openrouter_metadata?: {
    endpoints?: { available?: { provider?: unknown; selected?: unknown }[] };
  };
  error?: ErrorBody;
}

interface ErrorBody {
  code?: unknown;
  message?: unknown;
  metadata?: { error_type?: unknown } | null;
}

/**
 * POST one chat completion and parse the reply. Network failures, a timeout, 408, 429, 5xx and a transient
 * error reported inside a 200 (OpenRouter sends the status once a host accepts the request) retry with the
 * shared backoff, a Retry-After winning; anything else throws `OpenRouterError`, which carries the status,
 * the error type and a capped message, never a body.
 */
async function postChat(
  body: unknown,
  opts: { apiKey: string; timeoutMs: number; maxRetries: number },
): Promise<ChatReply> {
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < opts.maxRetries;
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
          "X-OpenRouter-Title": "opusfinder-eval",
          // Adds `openrouter_metadata` to the reply: which endpoint was selected.
          "X-OpenRouter-Metadata": "enabled",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      if (!canRetry) throw err;
      await backoff(attempt);
      continue;
    }
    let reply: ChatReply | undefined;
    try {
      reply = (await res.json()) as ChatReply;
    } catch (err) {
      // An error status with no JSON body still gets its status below. A 200 that can't be read is not
      // retried: the host already ran the request.
      if (res.ok) {
        if (err instanceof SyntaxError) {
          throw new OpenRouterError(res.status, "invalid_json", "the reply is not JSON");
        }
        throw err;
      }
    }
    const error = reply?.error ?? reply?.choices?.[0]?.error;
    if (res.ok && !error && reply) return reply;

    const status = res.ok && typeof error?.code === "number" ? error.code : res.status;
    const type = text(error?.metadata?.error_type);
    const transient = type
      ? TRANSIENT_ERROR_TYPES.has(type)
      : status === 408 || status === 429 || status >= 500;
    if (transient && canRetry) {
      await backoff(attempt, res.headers.get("retry-after"));
      continue;
    }
    throw new OpenRouterError(
      res.status,
      type ?? "error",
      (text(error?.message) ?? res.statusText).slice(0, MESSAGE_MAX),
    );
  }
}

/** The host that served a reply: the endpoint the routing metadata marks selected, else the reply's own
 *  `provider`. Null when the reply names neither. */
function servedHost(reply: ChatReply): string | null {
  const selected = reply.openrouter_metadata?.endpoints?.available?.find(
    (e) => e.selected === true,
  );
  return text(selected?.provider) ?? text(reply.provider);
}

function readUsage(u: ChatReply["usage"]): ModelCallUsage {
  return {
    inputTokens: count(u?.prompt_tokens),
    outputTokens: count(u?.completion_tokens),
    reasoningTokens: count(u?.completion_tokens_details?.reasoning_tokens),
    cachedInputTokens: count(u?.prompt_tokens_details?.cached_tokens),
    cacheWriteTokens: count(u?.prompt_tokens_details?.cache_write_tokens),
    costUsd: count(u?.cost),
  };
}

/** A chat message's text: a plain string, or the text parts of a content array, joined. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: unknown; text?: unknown }) =>
      part?.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

// A reply names its host by display name ("DeepInfra", "Google") while a route pins slugs ("deepinfra",
// "google-vertex"), and the two aren't derivable from each other, so OpenRouter's own provider list
// translates. Fetched once per process (it's public and unmetered); a failed fetch isn't remembered.
let providerNames: Promise<Map<string, string>> | undefined;

/** The display names of the route's hosts. Throws on a slug OpenRouter doesn't list. */
async function hostNames(hosts: readonly string[]): Promise<Set<string>> {
  providerNames ??= fetchProviderNames().catch((err: unknown) => {
    providerNames = undefined;
    throw err;
  });
  const bySlug = await providerNames;
  return new Set(
    hosts.map((host) => {
      // `provider[/variant][/region][/tier]`: the provider is the first segment.
      const name = bySlug.get(host.split("/")[0] ?? "");
      if (!name) throw new Error(`callModel(): "${host}" is not an OpenRouter provider slug.`);
      return name;
    }),
  );
}

async function fetchProviderNames(): Promise<Map<string, string>> {
  const res = await fetch(`${BASE_URL}/providers`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new OpenRouterError(res.status, "providers", "could not list OpenRouter's providers");
  }
  const body = (await res.json()) as { data?: { slug?: unknown; name?: unknown }[] };
  const bySlug = new Map<string, string>();
  for (const p of body.data ?? []) {
    if (typeof p.slug === "string" && typeof p.name === "string") bySlug.set(p.slug, p.name);
  }
  return bySlug;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
