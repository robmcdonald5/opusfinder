import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OpenRouterError } from "@opusfinder/llm/node";
import { rejectionOf } from "@test/rejection";

import { callModel, ModelReplyError, type ModelRoute } from "./model-caller";
import { toStrictJsonSchema } from "./strict-schema";

// The eval's any-model caller, over a stubbed fetch. Pins what a caller of it cannot switch off (the
// request runs only on the named hosts, only where every parameter is honoured, never where inputs are
// trained on), that a reply from any other host is refused, that an unusable reply is a typed error still
// carrying what it cost and is never re-sent, and which failures are retried. The shared backoff is mocked
// instant.
vi.mock("@opusfinder/shared/async", () => ({ backoff: vi.fn(async () => {}) }));

const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const PROVIDERS_URL = "https://openrouter.ai/api/v1/providers";
const PROVIDERS = {
  data: [
    { slug: "deepinfra", name: "DeepInfra" },
    { slug: "google-vertex", name: "Google" },
    { slug: "anthropic", name: "Anthropic" },
  ],
};

const ROUTE: ModelRoute = { model: "deepseek/deepseek-v4.1-flash", hosts: ["deepinfra/fp8"] };
const Verdict = z.object({ verdict: z.enum(["good", "bad"]), score: z.number().min(0).max(1) });
const USAGE = {
  prompt_tokens: 1200,
  completion_tokens: 90,
  total_tokens: 1290,
  cost: 0.00042,
  prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 40 },
};
const SPENT = {
  inputTokens: 1200,
  outputTokens: 90,
  reasoningTokens: 40,
  cachedInputTokens: 1000,
  cacheWriteTokens: 0,
  costUsd: 0.00042,
};

/** A chat-completions reply served by `host`, as the routing metadata reports it. */
function chatReply(
  over: {
    content?: unknown;
    finishReason?: string | null;
    refusal?: string;
    host?: string | null;
  } = {},
) {
  const host = over.host === undefined ? "DeepInfra" : over.host;
  return {
    id: "gen-test",
    model: "deepseek/deepseek-v4.1-flash-20260910",
    choices: [
      {
        index: 0,
        finish_reason: over.finishReason === undefined ? "stop" : over.finishReason,
        message: {
          role: "assistant",
          content: over.content === undefined ? '{"verdict":"good","score":0.8}' : over.content,
          ...(over.refusal ? { refusal: over.refusal } : {}),
        },
      },
    ],
    usage: USAGE,
    ...(host === null
      ? {}
      : {
          openrouter_metadata: {
            endpoints: {
              total: 2,
              available: [
                { provider: "Novita", model: "deepseek/deepseek-v4.1-flash", selected: false },
                { provider: host, model: "deepseek/deepseek-v4.1-flash", selected: true },
              ],
            },
          },
        }),
  };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

interface ChatRequest {
  headers: Headers;
  body: Record<string, unknown>;
}

/** Stub fetch: the provider list is always served; each chat request takes the next of `replies` (the last
 *  one repeats). Returns the chat requests seen. */
function stubOpenRouter(...replies: (() => Response | Promise<Response>)[]): ChatRequest[] {
  const seen: ChatRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === PROVIDERS_URL) return json(PROVIDERS);
      expect(url).toBe(CHAT_URL);
      seen.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      const reply = replies[Math.min(seen.length, replies.length) - 1];
      if (!reply) throw new Error("no reply stubbed");
      return reply();
    }),
  );
  return seen;
}

const call = (over: Partial<Parameters<typeof callModel<z.infer<typeof Verdict>>>[0]> = {}) =>
  callModel({
    route: ROUTE,
    schema: Verdict,
    messages: [{ role: "user", content: "Judge this job." }],
    apiKey: "sk-or-test",
    ...over,
  });

describe("callModel", () => {
  beforeEach(() => vi.stubEnv("OPENROUTER_API_KEY", "sk-or-env"));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends a strict JSON schema to the pinned hosts only, with no fallback and no training on inputs", async () => {
    const seen = stubOpenRouter(() => json(chatReply()));

    await call({
      route: { ...ROUTE, hosts: ["deepinfra/fp8", "google-vertex"], quantizations: ["fp8"] },
      schemaName: "verdict",
      system: "You are a judge.",
      cacheSystem: true,
      maxOutputTokens: 512,
      reasoningEffort: "low",
      temperature: 0,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-or-test");
    expect(seen[0]?.headers.get("x-openrouter-metadata")).toBe("enabled");
    expect(seen[0]?.body).toEqual({
      model: "deepseek/deepseek-v4.1-flash",
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "You are a judge.", cache_control: { type: "ephemeral" } },
          ],
        },
        { role: "user", content: "Judge this job." },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "verdict",
          strict: true,
          schema: toStrictJsonSchema(Verdict),
        },
      },
      max_completion_tokens: 512,
      reasoning: { effort: "low" },
      temperature: 0,
      provider: {
        only: ["deepinfra/fp8", "google-vertex"],
        order: ["deepinfra/fp8", "google-vertex"],
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: "deny",
        quantizations: ["fp8"],
      },
    });
  });

  it("sends only what the call sets, and falls back to the environment's key", async () => {
    const seen = stubOpenRouter(() => json(chatReply()));

    await call({ apiKey: undefined });

    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-or-env");
    expect(Object.keys(seen[0]?.body ?? {}).sort()).toEqual([
      "max_completion_tokens",
      "messages",
      "model",
      "provider",
      "response_format",
    ]);
    expect(seen[0]?.body.messages).toEqual([{ role: "user", content: "Judge this job." }]);
    expect(seen[0]?.body.provider).toEqual({
      only: ["deepinfra/fp8"],
      order: ["deepinfra/fp8"],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
    });
  });

  it("returns the validated object with its tokens, cost, host and model build", async () => {
    stubOpenRouter(() => json(chatReply()));

    expect(await call()).toEqual({
      object: { verdict: "good", score: 0.8 },
      usage: SPENT,
      host: "DeepInfra",
      servedModel: "deepseek/deepseek-v4.1-flash-20260910",
    });
  });

  it("reads the host from the reply's own provider field when there is no routing metadata", async () => {
    stubOpenRouter(() => json({ ...chatReply({ host: null }), provider: "DeepInfra" }));

    expect((await call()).host).toBe("DeepInfra");
  });

  it("matches a host by OpenRouter's name for its slug, not by spelling", async () => {
    stubOpenRouter(() => json(chatReply({ host: "Google" })));

    const result = await call({
      route: { model: "anthropic/claude-haiku-5.5", hosts: ["google-vertex/us"] },
    });

    expect(result.host).toBe("Google");
  });

  it("refuses a reply served by a host that isn't pinned, and still reports what it cost", async () => {
    const seen = stubOpenRouter(() => json(chatReply({ host: "Novita" })));

    const err = await rejectionOf(call());

    expect(err).toBeInstanceOf(ModelReplyError);
    expect(err).toMatchObject({
      reason: "unpinned_host",
      spent: SPENT,
      served: { host: "Novita", model: "deepseek/deepseek-v4.1-flash-20260910" },
    });
    expect(err.message).toBe(
      "callModel(deepseek/deepseek-v4.1-flash): served by Novita, not a pinned host (deepinfra/fp8).",
    );
    expect(seen).toHaveLength(1);
  });

  it("refuses a reply that doesn't say which host served it", async () => {
    stubOpenRouter(() => json(chatReply({ host: null })));

    const err = await rejectionOf(call());

    expect(err).toMatchObject({ reason: "unpinned_host", served: { host: null } });
  });

  it("rejects a host slug OpenRouter doesn't list before sending anything", async () => {
    const seen = stubOpenRouter(() => json(chatReply()));

    const err = await rejectionOf(call({ route: { ...ROUTE, hosts: ["deepinfar"] } }));

    expect(err.message).toBe('callModel(): "deepinfar" is not an OpenRouter provider slug.');
    expect(seen).toHaveLength(0);
  });

  it.each([
    ["truncated", chatReply({ finishReason: "length", content: '{"verdict":"go' })],
    ["refused", chatReply({ finishReason: "content_filter", content: null })],
    ["refused", chatReply({ refusal: "I can't help with that.", content: null })],
    ["incomplete", chatReply({ finishReason: "tool_calls", content: null })],
    ["incomplete", chatReply({ finishReason: null })],
    ["off_schema", chatReply({ content: "Sure! Here is the verdict." })],
    ["off_schema", chatReply({ content: "" })],
    ["off_schema", chatReply({ content: '{"verdict":"maybe","score":7}' })],
  ])(
    "throws a %s reply as a typed error carrying its cost, without a second attempt",
    async (reason, reply) => {
      const seen = stubOpenRouter(() => json(reply));

      const err = await rejectionOf(call());

      expect(err).toBeInstanceOf(ModelReplyError);
      expect(err).toMatchObject({ reason, spent: SPENT, served: { host: "DeepInfra" } });
      expect(seen).toHaveLength(1);
    },
  );

  it("names the failing fields of an off-schema reply, never its content", async () => {
    stubOpenRouter(() => json(chatReply({ content: '{"verdict":"SECRET-CV-TEXT","score":7}' })));

    const err = await rejectionOf(call());

    expect(err.message).toBe(
      "callModel(deepseek/deepseek-v4.1-flash): the reply does not match the schema (at verdict, score).",
    );
  });

  it("reads a reply whose content is an array of text parts", async () => {
    stubOpenRouter(() =>
      json(
        chatReply({
          content: [
            { type: "text", text: '{"verdict":"bad",' },
            { type: "text", text: '"score":0.1}' },
          ],
        }),
      ),
    );

    expect((await call()).object).toEqual({ verdict: "bad", score: 0.1 });
  });

  it("retries a 429, a 5xx and a network failure, then returns the reply", async () => {
    const seen = stubOpenRouter(
      () => new Response(null, { status: 429, headers: { "retry-after": "0" } }),
      () => json({ error: { code: 503, message: "No provider available" } }, 503),
      () => Promise.reject(new TypeError("fetch failed")),
      () => json(chatReply()),
    );

    const result = await call({ maxRetries: 3 });

    expect(seen).toHaveLength(4);
    expect(result.object).toEqual({ verdict: "good", score: 0.8 });
  });

  it("retries a transient provider error reported inside a 200", async () => {
    const seen = stubOpenRouter(
      () =>
        json({
          id: "gen-test",
          error: {
            code: 502,
            message: "Provider returned an empty response",
            metadata: { error_type: "provider_unavailable" },
          },
        }),
      () =>
        json({
          choices: [
            {
              finish_reason: "error",
              message: { role: "assistant", content: '{"verd' },
              error: {
                code: 429,
                message: "Rate limit exceeded",
                metadata: { error_type: "rate_limit_exceeded" },
              },
            },
          ],
        }),
      () => json(chatReply()),
    );

    await call();

    expect(seen).toHaveLength(3);
  });

  it("stops after maxRetries and throws the status and error type", async () => {
    const seen = stubOpenRouter(() =>
      json(
        {
          error: {
            code: 429,
            message: "Rate limit exceeded",
            metadata: { error_type: "rate_limit_exceeded" },
          },
        },
        429,
      ),
    );

    const err = await rejectionOf(call({ maxRetries: 1 }));

    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err).toMatchObject({ status: 429, type: "rate_limit_exceeded" });
    expect(seen).toHaveLength(2);
  });

  it("does not retry a request error, and throws a capped message without the body", async () => {
    const seen = stubOpenRouter(() =>
      json(
        {
          error: {
            code: 404,
            message: `No allowed providers are available for the selected model. ${"x".repeat(400)}`,
          },
          user_id: "user_should_not_leak",
        },
        404,
      ),
    );

    const err = await rejectionOf(call());

    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err).toMatchObject({ status: 404, type: "error" });
    expect(err.message.length).toBeLessThanOrEqual("OpenRouter 404 error: ".length + 300);
    expect(err.message).not.toContain("user_should_not_leak");
    expect(seen).toHaveLength(1);
  });

  it("does not retry a non-transient error reported inside a 200", async () => {
    const seen = stubOpenRouter(() =>
      json({
        error: {
          code: 400,
          message: "This endpoint's maximum context length is 64000 tokens",
          metadata: { error_type: "context_length_exceeded" },
        },
      }),
    );

    const err = await rejectionOf(call());

    expect(err).toMatchObject({ status: 200, type: "context_length_exceeded" });
    expect(seen).toHaveLength(1);
  });

  it("rethrows a network failure once the retries are spent", async () => {
    const seen = stubOpenRouter(() => Promise.reject(new TypeError("fetch failed")));

    const err = await rejectionOf(call({ maxRetries: 0 }));

    expect(err.message).toBe("fetch failed");
    expect(seen).toHaveLength(1);
  });

  it("rejects a non-positive output cap before sending anything", async () => {
    const seen = stubOpenRouter(() => json(chatReply()));

    const err = await rejectionOf(call({ maxOutputTokens: 0 }));

    expect(err.message).toBe("callModel(): maxOutputTokens must be >= 1 (got 0).");
    expect(seen).toHaveLength(0);
  });
});

describe("callModel — the provider list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("fails without a paid request when the list can't be fetched, and asks again on the next call", async () => {
    vi.resetModules();
    const fresh = await import("./model-caller");
    let listCalls = 0;
    let chatCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === PROVIDERS_URL) {
          listCalls += 1;
          return listCalls === 1 ? new Response(null, { status: 503 }) : json(PROVIDERS);
        }
        chatCalls += 1;
        return json(chatReply());
      }),
    );
    const params = {
      route: ROUTE,
      schema: Verdict,
      messages: [{ role: "user" as const, content: "Judge this job." }],
      apiKey: "sk-or-test",
    };

    const err = await rejectionOf(fresh.callModel(params));
    expect(err.message).toBe("OpenRouter 503 providers: could not list OpenRouter's providers");
    expect(chatCalls).toBe(0);

    await fresh.callModel(params);
    await fresh.callModel(params);
    expect(listCalls).toBe(2);
    expect(chatCalls).toBe(2);
  });
});
