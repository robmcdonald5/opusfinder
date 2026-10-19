import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  messagesReply,
  OPENROUTER_MESSAGES_URL,
  type MessagesReplyOpts,
} from "@test/msw/fixtures/openrouter";
import { server } from "@test/msw/server";
import { rejectionOf } from "@test/rejection";

import { generateObject, ObjectGenerationError, parseObject } from "./generate-object";
import { OpenRouterError } from "./openrouter";

// generateObject() over OpenRouter's Messages API, intercepted by MSW. Asserts the constrained-decoding
// request (output_config.format, never a forced tool) and the wrapper's own outcomes: an off-schema reply is
// retried once with usage summed, a second one throws, a truncated or refused reply throws without a retry,
// and a provider error stays unwrapped. Zero live egress.

const schema = z.object({ name: z.string(), age: z.number().min(0).max(150) });

type CapturedBody = {
  tools?: unknown;
  tool_choice?: unknown;
  output_config?: {
    format?: { type?: string; schema?: { properties?: Record<string, { description?: string }> } };
  };
  max_tokens?: number;
};

/** Serve the given replies in order, capturing each request body. */
function replies(...rs: MessagesReplyOpts[]): CapturedBody[] {
  const bodies: CapturedBody[] = [];
  server.use(
    http.post(OPENROUTER_MESSAGES_URL, async ({ request }) => {
      bodies.push((await request.json()) as CapturedBody);
      return HttpResponse.json(messagesReply(rs[bodies.length - 1] ?? rs[rs.length - 1]));
    }),
  );
  return bodies;
}

const call = () =>
  generateObject({ model: "haiku", schema, messages: [{ role: "user", content: "x" }] });

describe("generateObject — OpenRouter Messages over MSW", () => {
  beforeAll(() => vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test"));
  afterAll(() => vi.unstubAllEnvs());

  it("constrains decoding to the schema and returns the validated object", async () => {
    const bodies = replies({ text: JSON.stringify({ name: "Ada", age: 36 }) });

    const result = await call();

    expect(result.object).toEqual({ name: "Ada", age: 36 });
    expect(result.stopReason).toBe("end_turn");
    const body = bodies[0];
    expect(body?.output_config?.format?.type).toBe("json_schema");
    // The bound the API can't enforce is described to the model instead (and validated after).
    expect(body?.output_config?.format?.schema?.properties?.age?.description).toContain("150");
    expect(body?.tools).toBeUndefined();
    expect(body?.tool_choice).toBeUndefined();
    expect(body?.max_tokens).toBe(2048);
  });

  it("retries an off-schema reply once and sums both attempts' usage", async () => {
    const bodies = replies(
      {
        text: JSON.stringify({ name: "Ada", age: 999 }),
        usage: { input_tokens: 10, output_tokens: 5, cost: 0.001 },
      },
      {
        text: JSON.stringify({ name: "Ada", age: 36 }),
        usage: { input_tokens: 10, output_tokens: 5, cost: 0.001 },
      },
    );

    const result = await call();

    expect(bodies).toHaveLength(2);
    expect(result.object.age).toBe(36);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10, costUsd: 0.002 });
  });

  it("throws ObjectGenerationError after a second off-schema reply, keeping the parse error as cause", async () => {
    const bodies = replies({ text: "not json at all" });

    const err = await rejectionOf(call());

    expect(bodies).toHaveLength(2);
    expect(err).toBeInstanceOf(ObjectGenerationError);
    expect(err.message).toBe(
      "generateObject(): the model did not return schema-valid JSON in 2 attempts.",
    );
    expect(err.cause).toBeDefined();
  });

  it("throws an actionable truncation error without retrying", async () => {
    const bodies = replies({ text: '{"name": "Ad', stopReason: "max_tokens" });

    const err = await rejectionOf(call());

    expect(bodies).toHaveLength(1);
    expect(err.message).toBe(
      "generateObject(): output was truncated at maxOutputTokens=2048; raise the caller's maxOutputTokens or lower its effort.",
    );
  });

  it("throws on a refusal without retrying", async () => {
    const bodies = replies({ text: "", stopReason: "refusal" });

    const err = await rejectionOf(call());

    expect(bodies).toHaveLength(1);
    expect(err).toBeInstanceOf(ObjectGenerationError);
    expect(err.message).toContain('"refusal"');
  });

  it("propagates a provider (non-200) error UNWRAPPED", async () => {
    server.use(
      http.post(OPENROUTER_MESSAGES_URL, () =>
        HttpResponse.json(
          { type: "error", error: { type: "invalid_request_error", message: "bad" } },
          { status: 400 },
        ),
      ),
    );

    const err = await rejectionOf(call());

    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err).not.toBeInstanceOf(ObjectGenerationError);
  });
});

describe("parseObject", () => {
  it("returns the validated object, or throws ObjectGenerationError", () => {
    expect(parseObject(schema, JSON.stringify({ name: "Ada", age: 36 }))).toEqual({
      name: "Ada",
      age: 36,
    });
    expect(() => parseObject(schema, '{"name": 1}')).toThrow(ObjectGenerationError);
  });
});
