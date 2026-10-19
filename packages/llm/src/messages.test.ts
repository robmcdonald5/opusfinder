import { describe, expect, it } from "vitest";

import { buildMessagesBody, readMessage, toSyncBody, type CallOptions } from "./messages";

// Pure unit for the ONE request builder the sync calls and the batch share. It decides where the cache
// breakpoint lands, how each tier spells thinking-off (a wrong spelling is a 400, or a whole batch failing
// after its 202), and which OpenRouter routing fields ride on a sync call — so the wire body is pinned.

const SYNC = { defaultMaxOutputTokens: 1024, cacheTtl: "5m" as const };
const BATCH = { defaultMaxOutputTokens: 1024, cacheTtl: "1h" as const, inBatch: true };

function opts(overrides: Partial<CallOptions> = {}): CallOptions {
  return { model: "haiku", messages: [{ role: "user", content: "hi" }], ...overrides };
}

describe("buildMessagesBody", () => {
  it("defaults max_tokens, sends adaptive thinking, and omits system/output_config when unset", () => {
    expect(buildMessagesBody("generate", opts(), SYNC)).toEqual({
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
    });
  });

  it("puts effort and a JSON-schema format together in output_config", () => {
    const format = { type: "json_schema" as const, schema: { type: "object" } };
    const body = buildMessagesBody("generateObject", opts({ effort: "low" }), { ...SYNC, format });
    expect(body.output_config).toEqual({ effort: "low", format });
  });

  it("marks a cached system prompt with a 5-minute breakpoint on a sync call and 1 hour in a batch", () => {
    const cached = opts({ system: "rubric", cacheSystem: true });
    expect(buildMessagesBody("generate", cached, SYNC).system).toEqual([
      { type: "text", text: "rubric", cache_control: { type: "ephemeral" } },
    ]);
    expect(buildMessagesBody("submitBatch", cached, BATCH).system).toEqual([
      { type: "text", text: "rubric", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
  });

  it("sends an uncached system prompt as a plain string", () => {
    expect(buildMessagesBody("generate", opts({ system: "plain" }), SYNC).system).toBe("plain");
  });

  it("spells thinking-off per tier: disabled for haiku, between_tools for sonnet", () => {
    expect(buildMessagesBody("generate", opts({ thinking: "off" }), SYNC).thinking).toEqual({
      type: "disabled",
    });
    expect(
      buildMessagesBody("generate", opts({ model: "sonnet", thinking: "off" }), SYNC).thinking,
    ).toEqual({
      type: "between_tools",
    });
  });

  it.each(["xhigh", "max"] as const)("rejects thinking-off at effort %s", (effort) => {
    expect(() => buildMessagesBody("generate", opts({ thinking: "off", effort }), SYNC)).toThrow(
      `generate(): thinking "off" needs effort "high" or below (got "${effort}").`,
    );
  });

  it("rejects sonnet thinking-off in a batch but allows haiku's", () => {
    expect(() =>
      buildMessagesBody("submitBatch", opts({ model: "sonnet", thinking: "off" }), BATCH),
    ).toThrow(/the Batch API rejects sonnet's thinking-off setting/);
    expect(buildMessagesBody("submitBatch", opts({ thinking: "off" }), BATCH).thinking).toEqual({
      type: "disabled",
    });
  });

  it("encodes a PDF part as a base64 document block on a sync call and refuses it in a batch", () => {
    const withPdf = opts({
      messages: [
        {
          role: "user",
          content: [
            { type: "pdf", data: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
            { type: "text", text: "transcribe" },
          ],
        },
      ],
    });
    expect(buildMessagesBody("generate", withPdf, SYNC).messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" },
          },
          { type: "text", text: "transcribe" },
        ],
      },
    ]);
    expect(() => buildMessagesBody("submitBatch", withPdf, BATCH)).toThrow(
      /a PDF part can't be batched/,
    );
  });

  it("rejects a non-positive maxOutputTokens", () => {
    expect(() => buildMessagesBody("generate", opts({ maxOutputTokens: 0 }), SYNC)).toThrow(
      "generate(): maxOutputTokens must be >= 1 (got 0).",
    );
  });
});

describe("toSyncBody", () => {
  it("adds the model slug and the routing preferences", () => {
    const o = opts();
    const body = toSyncBody(o, buildMessagesBody("generate", o, SYNC));
    expect(body.model).toBe("anthropic/claude-haiku-5.5");
    expect(body.provider).toEqual({ require_parameters: true, data_collection: "deny" });
    expect(body).not.toHaveProperty("session_id");
  });

  it("derives one stable session_id per (model, cached system prompt)", () => {
    const sessionOf = (o: CallOptions) =>
      toSyncBody(o, buildMessagesBody("generate", o, SYNC)).session_id;
    const a = sessionOf(opts({ system: "rubric A", cacheSystem: true }));
    expect(a).toMatch(/^cache-[0-9a-f]{40}$/);
    // Another chunk under the same prefix keeps the session; another prefix or tier gets its own.
    expect(
      sessionOf(
        opts({
          system: "rubric A",
          cacheSystem: true,
          messages: [{ role: "user", content: "chunk 2" }],
        }),
      ),
    ).toBe(a);
    expect(sessionOf(opts({ system: "rubric B", cacheSystem: true }))).not.toBe(a);
    expect(sessionOf(opts({ model: "sonnet", system: "rubric A", cacheSystem: true }))).not.toBe(a);
    expect(sessionOf(opts({ system: "rubric A" }))).toBeUndefined();
  });
});

describe("readMessage", () => {
  it("joins the text blocks, skips thinking blocks, and maps usage, cache counters and cost", () => {
    expect(
      readMessage({
        content: [
          { type: "thinking", text: undefined },
          { type: "text", text: "part one, " },
          { type: "text", text: "part two" },
        ],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_creation_input_tokens: 600,
          cache_read_input_tokens: 4096,
          cost: 0.00042,
        },
      }),
    ).toEqual({
      text: "part one, part two",
      stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 8, costUsd: 0.00042 },
      cache: { creationInputTokens: 600, readInputTokens: 4096 },
    });
  });

  it("defaults missing or non-finite counters to 0 and a missing stop reason to null", () => {
    expect(readMessage({ usage: { input_tokens: Number.NaN, cost: null } })).toEqual({
      text: "",
      stopReason: null,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      cache: { creationInputTokens: 0, readInputTokens: 0 },
    });
  });
});
