import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { anthropicMessage } from "@test/msw/fixtures/anthropic";
import { server } from "@test/msw/server";
import { rejectionOf } from "@test/rejection";

import { generate } from "./generate";

// generate() over @ai-sdk/anthropic, intercepted by MSW at the Anthropic Messages boundary (Q3 declined a
// model DI seam, so MSW is the sanctioned seam). Asserts the request the SDK SENDS (model / max_tokens /
// cache_control breakpoint / temperature) and that a WIRE response maps back onto GenerateResult — including
// the prompt-cache counters, whose fixture is deliberately snake_case (see anthropicMessage). Zero live
// egress: onUnhandledRequest:"error". Pure cache-plumbing (guards, promotion) is covered in cache-plumbing.test.ts.

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

type CapturedBody = {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  system?: unknown;
};

describe("generate — Anthropic Messages over MSW", () => {
  beforeAll(() => vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test"));
  afterAll(() => vi.unstubAllEnvs());

  it("marks the system prompt as an ephemeral cache breakpoint and maps a text completion", async () => {
    let body: CapturedBody | undefined;
    server.use(
      http.post(MESSAGES_URL, async ({ request }) => {
        body = (await request.json()) as CapturedBody;
        return HttpResponse.json(
          anthropicMessage({ text: "the answer", usage: { input_tokens: 100, output_tokens: 20 } }),
        );
      }),
    );

    const result = await generate({
      model: "haiku",
      system: "You are a careful assistant.",
      cacheSystem: true,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.text).toBe("the answer");
    expect(result.finishReason).toBe("stop"); // end_turn -> stop
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(20);

    expect(body?.model).toBe("claude-haiku-4-5");
    expect(body?.max_tokens).toBe(1024); // DEFAULT_MAX_OUTPUT_TOKENS
    const system = body?.system as Array<{ cache_control?: { type?: string } }>;
    expect(system[0]?.cache_control?.type).toBe("ephemeral");
  });

  it("sends NO cache_control on the system when cacheSystem is falsy", async () => {
    let body: CapturedBody | undefined;
    server.use(
      http.post(MESSAGES_URL, async ({ request }) => {
        body = (await request.json()) as CapturedBody;
        return HttpResponse.json(anthropicMessage({ text: "ok" }));
      }),
    );

    await generate({
      model: "haiku",
      system: "You are a careful assistant.",
      messages: [{ role: "user", content: "hi" }],
    });

    const raw = JSON.stringify(body?.system);
    expect(raw).not.toContain("cache_control");
  });

  it("surfaces the Anthropic prompt-cache counters from the wire usage fields", async () => {
    server.use(
      http.post(MESSAGES_URL, () =>
        HttpResponse.json(
          anthropicMessage({
            text: "cached",
            usage: {
              input_tokens: 12,
              output_tokens: 8,
              cache_creation_input_tokens: 512,
              cache_read_input_tokens: 4096,
            },
          }),
        ),
      ),
    );

    const result = await generate({
      model: "haiku",
      system: "big cached prompt",
      cacheSystem: true,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.cache).toEqual({ creationInputTokens: 512, readInputTokens: 4096 });
  });

  it("resolves the sonnet alias to its dated model id", async () => {
    let body: CapturedBody | undefined;
    server.use(
      http.post(MESSAGES_URL, async ({ request }) => {
        body = (await request.json()) as CapturedBody;
        return HttpResponse.json(anthropicMessage({ text: "ok", model: "claude-sonnet-4-6" }));
      }),
    );

    await generate({ model: "sonnet", messages: [{ role: "user", content: "hi" }] });

    expect(body?.model).toBe("claude-sonnet-4-6");
  });

  it("forwards an explicit maxOutputTokens + temperature, and omits temperature when unset", async () => {
    const bodies: CapturedBody[] = [];
    server.use(
      http.post(MESSAGES_URL, async ({ request }) => {
        bodies.push((await request.json()) as CapturedBody);
        return HttpResponse.json(anthropicMessage({ text: "ok" }));
      }),
    );

    await generate({
      model: "haiku",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 256,
      temperature: 0.2,
    });
    await generate({ model: "haiku", messages: [{ role: "user", content: "hi" }] });

    expect(bodies[0]?.max_tokens).toBe(256);
    expect(bodies[0]?.temperature).toBe(0.2);
    expect(bodies[1]).not.toHaveProperty("temperature");
  });

  it("propagates a provider error unwrapped (no cache-plumbing wrapping)", async () => {
    server.use(
      http.post(MESSAGES_URL, () =>
        HttpResponse.json(
          { type: "error", error: { type: "invalid_request_error", message: "bad request" } },
          { status: 400 },
        ),
      ),
    );

    const err = await rejectionOf(
      generate({ model: "haiku", messages: [{ role: "user", content: "hi" }] }),
    );

    // The point of this test: generate() has NO error-wrapping (unlike generateObject, which catches
    // NoObjectGeneratedError). A bare rejects.toThrow() would stay green even if wrapping crept in, so pin
    // the "unwrapped" half — the message must NOT be a generate() wrapper — mirroring the generateObject sibling.
    expect(err.message).not.toMatch(/^generate\(\):/);
  });
});
