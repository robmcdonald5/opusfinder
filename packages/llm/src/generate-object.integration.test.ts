import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { anthropicMessage } from "@test/msw/fixtures/anthropic";
import { server } from "@test/msw/server";
import { rejectionOf } from "@test/rejection";

import { generateObject } from "./generate-object";

// generateObject() over @ai-sdk/anthropic (STABLE tool mode), intercepted by MSW. Asserts the forced-tool
// request shape (tool name + tool_choice, NOT the brittle serialized zod->json schema) and the two error
// branches the wrapper adds: a truncation (max_tokens) message vs a generic schema-invalid message, with the
// SDK's NoObjectGeneratedError kept as `cause`; a provider (non-200) error stays UNWRAPPED. Zero live egress.

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const schema = z.object({ name: z.string(), age: z.number() });

type CapturedBody = {
  tools?: { name?: string }[];
  tool_choice?: { type?: string; name?: string };
  max_tokens?: number;
};

describe("generateObject — Anthropic Messages over MSW", () => {
  beforeAll(() => vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test"));
  afterAll(() => vi.unstubAllEnvs());

  it("sends a forced 'json' tool and returns the validated object", async () => {
    let body: CapturedBody | undefined;
    server.use(
      http.post(MESSAGES_URL, async ({ request }) => {
        body = (await request.json()) as CapturedBody;
        return HttpResponse.json(
          anthropicMessage({ toolUse: { name: "json", input: { name: "Ada", age: 36 } } }),
        );
      }),
    );

    const result = await generateObject({
      model: "haiku",
      schema,
      messages: [{ role: "user", content: "extract the person" }],
    });

    expect(result.object).toEqual({ name: "Ada", age: 36 });
    expect(result.finishReason).toBe("stop"); // tool_use -> stop
    expect(body?.tools?.[0]?.name).toBe("json");
    expect(body?.tool_choice).toMatchObject({ type: "tool", name: "json" });
    expect(body?.max_tokens).toBe(2048); // DEFAULT_MAX_OUTPUT_TOKENS for generateObject
  });

  it("wraps a truncated (max_tokens) response as an actionable error, keeping the SDK error as cause", async () => {
    server.use(
      http.post(MESSAGES_URL, () =>
        HttpResponse.json(anthropicMessage({ text: "partial", stopReason: "max_tokens" })),
      ),
    );

    const err = await rejectionOf(
      generateObject({ model: "haiku", schema, messages: [{ role: "user", content: "x" }] }),
    );

    expect(err.message).toBe(
      "generateObject(): output was truncated at maxOutputTokens=2048; raise maxOutputTokens (set by the caller, e.g. scripts/seams.ts).",
    );
    expect(err.cause).toBeDefined(); // the SDK's NoObjectGeneratedError is preserved
  });

  it("wraps a non-truncation unparseable response with the finishReason in the message", async () => {
    server.use(
      http.post(MESSAGES_URL, () =>
        HttpResponse.json(anthropicMessage({ text: "not json at all", stopReason: "end_turn" })),
      ),
    );

    const err = await rejectionOf(
      generateObject({ model: "haiku", schema, messages: [{ role: "user", content: "x" }] }),
    );

    expect(err.message).toBe(
      "generateObject(): the model did not return schema-valid JSON (finishReason=stop).",
    );
  });

  it("propagates a provider (non-200) error UNWRAPPED, not as a generateObject() message", async () => {
    server.use(
      http.post(MESSAGES_URL, () =>
        HttpResponse.json(
          { type: "error", error: { type: "invalid_request_error", message: "bad request" } },
          { status: 400 },
        ),
      ),
    );

    const err = await rejectionOf(
      generateObject({ model: "haiku", schema, messages: [{ role: "user", content: "x" }] }),
    );

    expect(err.message).not.toMatch(/^generateObject\(\):/); // the wrapper only catches NoObjectGeneratedError
  });
});
