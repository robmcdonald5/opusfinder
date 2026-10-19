import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { messagesReply, OPENROUTER_MESSAGES_URL } from "@test/msw/fixtures/openrouter";
import { server } from "@test/msw/server";
import { rejectionOf } from "@test/rejection";

import { generate } from "./generate";
import { OpenRouterError } from "./openrouter";

// generate() over OpenRouter's Messages API, intercepted by MSW. Asserts the request it SENDS (model slug,
// max_tokens, cache breakpoint, effort, routing fields) and that a WIRE reply maps back onto GenerateResult,
// including the cache counters and OpenRouter's cost. The body builder itself is unit-tested in
// messages.test.ts. Zero live egress: onUnhandledRequest:"error".

type CapturedBody = {
  model?: string;
  max_tokens?: number;
  system?: unknown;
  thinking?: unknown;
  output_config?: unknown;
  provider?: unknown;
  session_id?: string;
};

describe("generate — OpenRouter Messages over MSW", () => {
  beforeAll(() => vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test"));
  afterAll(() => vi.unstubAllEnvs());

  it("sends a cached system prompt, effort and routing fields, and maps the reply", async () => {
    let body: CapturedBody | undefined;
    server.use(
      http.post(OPENROUTER_MESSAGES_URL, async ({ request }) => {
        body = (await request.json()) as CapturedBody;
        return HttpResponse.json(
          messagesReply({
            text: "the answer",
            thinking: true,
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_creation_input_tokens: 512,
              cache_read_input_tokens: 0,
              cost: 0.00123,
            },
          }),
        );
      }),
    );

    const result = await generate({
      model: "haiku",
      system: "You are a careful assistant.",
      cacheSystem: true,
      effort: "low",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result).toEqual({
      text: "the answer",
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.00123 },
      cache: { creationInputTokens: 512, readInputTokens: 0 },
    });
    expect(body).toMatchObject({
      model: "anthropic/claude-haiku-5.5",
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: "You are a careful assistant.",
          cache_control: { type: "ephemeral" },
        },
      ],
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      provider: { require_parameters: true, data_collection: "deny" },
    });
    expect(body?.session_id).toMatch(/^cache-/);
  });

  it("sends the sonnet tier as its OpenRouter slug and returns a truncated reply without throwing", async () => {
    let body: CapturedBody | undefined;
    server.use(
      http.post(OPENROUTER_MESSAGES_URL, async ({ request }) => {
        body = (await request.json()) as CapturedBody;
        return HttpResponse.json(messagesReply({ text: "cut", stopReason: "max_tokens" }));
      }),
    );

    const result = await generate({
      model: "sonnet",
      maxOutputTokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(body?.model).toBe("anthropic/claude-sonnet-5.5");
    expect(body?.max_tokens).toBe(16);
    expect(result.stopReason).toBe("max_tokens"); // the caller decides what a truncated text means
  });

  it("propagates a provider error as OpenRouterError, unwrapped", async () => {
    server.use(
      http.post(OPENROUTER_MESSAGES_URL, () =>
        HttpResponse.json(
          { type: "error", error: { type: "invalid_request_error", message: "bad request" } },
          { status: 400 },
        ),
      ),
    );

    const err = await rejectionOf(
      generate({ model: "haiku", messages: [{ role: "user", content: "hi" }] }),
    );

    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err.message).not.toMatch(/^generate\(\):/);
  });
});
