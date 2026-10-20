import { beforeEach, describe, expect, it, vi } from "vitest";

const llm = vi.hoisted(() => {
  class ObjectGenerationError extends Error {}
  class OpenRouterError extends Error {
    constructor(
      readonly status: number,
      readonly type: string,
    ) {
      super(`OpenRouter ${status} ${type}: a message the provider wrote`);
    }
  }
  return {
    generateObject: vi.fn(),
    submitBatch: vi.fn(),
    pollBatch: vi.fn(),
    collectBatchResults: vi.fn(),
    ObjectGenerationError,
    OpenRouterError,
  };
});
vi.mock("@opusfinder/llm", () => llm);
vi.mock("@opusfinder/shared/async", () => ({ sleep: vi.fn(async () => {}) }));

import { buildLocationRequest } from "./model";
import { LocationAnswerSchema } from "./schema";
import { createLocationModel, toAnswer } from "./transport";

const ANSWER = { reason: "r", places: [], remoteCountries: ["US"], areas: [], confidence: "high" };

beforeEach(() => vi.resetAllMocks());

describe("createLocationModel", () => {
  it("sends one cached, schema-constrained Haiku call at low effort with thinking off, under a deadline", async () => {
    llm.generateObject.mockResolvedValue({ object: ANSWER });
    const request = buildLocationRequest("p0", { raw: "Remote - USA" });

    const answer = await createLocationModel().generate(request);

    expect(answer).toEqual({ status: "answered", text: JSON.stringify(ANSWER) });
    expect(llm.generateObject).toHaveBeenCalledWith({
      model: "haiku",
      system: request.system,
      cacheSystem: true,
      messages: [{ role: "user", content: request.user }],
      maxOutputTokens: 4096,
      effort: "low",
      thinking: "off",
      schema: LocationAnswerSchema,
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    ["an unusable reply", new llm.ObjectGenerationError("cut off"), "no-answer", "cut off"],
    [
      "a moderation rejection",
      new llm.OpenRouterError(403, "moderation"),
      "no-answer",
      "OpenRouter 403 moderation",
    ],
    [
      "a malformed request",
      new llm.OpenRouterError(400, "invalid_request_error"),
      "no-answer",
      "OpenRouter 400 invalid_request_error",
    ],
    ["a server error", new llm.OpenRouterError(503, "error"), "failed", "OpenRouter 503 error"],
    [
      "a rate limit",
      new llm.OpenRouterError(429, "rate_limit_exceeded"),
      "failed",
      "OpenRouter 429 rate_limit_exceeded",
    ],
    ["used-up credits", new llm.OpenRouterError(402, "error"), "failed", "OpenRouter 402 error"],
    [
      "an error after the provider accepted",
      new llm.OpenRouterError(200, "server"),
      "failed",
      "OpenRouter 200 server",
    ],
    ["the deadline", new DOMException("timed out", "TimeoutError"), "failed", "TimeoutError"],
    ["a network failure", new TypeError("fetch failed"), "failed", "TypeError"],
  ])("reads %s as %s", async (_, error, status, reason) => {
    llm.generateObject.mockRejectedValue(error);
    expect(await createLocationModel().generate(buildLocationRequest("p0", { raw: "x" }))).toEqual({
      status,
      reason,
    });
  });

  it("still throws what isn't the provider's doing", async () => {
    llm.generateObject.mockRejectedValue(new Error("OPENROUTER_API_KEY is not set"));
    await expect(
      createLocationModel().generate(buildLocationRequest("p0", { raw: "x" })),
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
  });

  it("submits a batch with the same call options, then waits for it to end and reads its answers", async () => {
    llm.submitBatch.mockResolvedValue("batch-1");
    llm.pollBatch
      .mockResolvedValueOnce({ status: "in_progress" })
      .mockRejectedValueOnce(new Error("a poll that failed"))
      .mockResolvedValueOnce({ status: "ended" });
    llm.collectBatchResults.mockResolvedValue({
      results: new Map([
        ["p0", { customId: "p0", status: "succeeded", text: "{}", stopReason: "end_turn" }],
      ]),
      costUsd: 0,
    });
    const model = createLocationModel();
    const requests = [buildLocationRequest("p0", { raw: "Columbus, OH" })];

    expect(await model.submitBatch(requests)).toBe("batch-1");
    expect(llm.submitBatch.mock.calls[0]![0][0]).toMatchObject({
      customId: "p0",
      model: "haiku",
      effort: "low",
      thinking: "off",
      cacheSystem: true,
      maxOutputTokens: 4096,
      schema: LocationAnswerSchema,
    });
    const answers = await model.collectBatch("batch-1");

    expect(llm.pollBatch).toHaveBeenCalledTimes(3);
    expect(answers).toEqual(new Map([["p0", { status: "answered", text: "{}" }]]));
  });

  it("gives up waiting after ten failed polls in a row", async () => {
    llm.pollBatch.mockRejectedValue(new Error("OpenRouter 503 error"));
    await expect(createLocationModel().collectBatch("batch-1")).rejects.toThrow(/503/);
    expect(llm.pollBatch).toHaveBeenCalledTimes(10);
    expect(llm.collectBatchResults).not.toHaveBeenCalled();
  });
});

describe("toAnswer", () => {
  it.each([
    [
      { status: "errored", error: "overloaded" },
      { status: "failed", reason: "overloaded" },
    ],
    [
      { status: "succeeded", stopReason: "max_tokens" },
      { status: "no-answer", reason: "max_tokens" },
    ],
    [
      { status: "succeeded", stopReason: "refusal" },
      { status: "no-answer", reason: "refusal" },
    ],
    [
      { status: "succeeded", stopReason: "end_turn", text: "{}" },
      { status: "answered", text: "{}" },
    ],
  ] as const)("%j → %j", (result, expected) => {
    expect(toAnswer({ customId: "p0", text: "", ...result })).toEqual(["p0", expected]);
  });
});
