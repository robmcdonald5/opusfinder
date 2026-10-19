import { beforeEach, describe, expect, it, vi } from "vitest";

const llm = vi.hoisted(() => {
  class ObjectGenerationError extends Error {}
  return { generateObject: vi.fn(), batchGenerate: vi.fn(), ObjectGenerationError };
});
vi.mock("@opusfinder/llm", () => llm);

import { buildLocationRequest } from "./model";
import { LocationAnswerSchema } from "./schema";
import { createLocationModel, toAnswer } from "./transport";

const ANSWER = { reason: "r", places: [], remoteCountries: ["US"], confidence: "high" };

beforeEach(() => vi.resetAllMocks());

describe("createLocationModel", () => {
  it("sends one cached, schema-constrained Haiku call at low effort with thinking off", async () => {
    llm.generateObject.mockResolvedValue({ object: ANSWER });
    const request = buildLocationRequest("p0", { raw: "Remote - USA" });

    const answer = await createLocationModel().generate(request);

    expect(answer).toEqual({ status: "answered", text: JSON.stringify(ANSWER) });
    expect(llm.generateObject).toHaveBeenCalledWith({
      model: "haiku",
      system: request.system,
      cacheSystem: true,
      messages: [{ role: "user", content: request.user }],
      maxOutputTokens: 1024,
      effort: "low",
      thinking: "off",
      schema: LocationAnswerSchema,
    });
  });

  it("reads an unusable reply as no answer, and lets a provider error throw", async () => {
    const model = createLocationModel();
    const request = buildLocationRequest("p0", { raw: "x" });
    llm.generateObject.mockRejectedValueOnce(new llm.ObjectGenerationError("cut off"));
    expect(await model.generate(request)).toEqual({ status: "no-answer", reason: "cut off" });
    llm.generateObject.mockRejectedValueOnce(new Error("OpenRouter 503"));
    await expect(model.generate(request)).rejects.toThrow(/503/);
  });

  it("sends a large set as batches of 2,000 with the same call options, and merges the results", async () => {
    llm.batchGenerate.mockImplementation(async (requests: { customId: string }[]) => ({
      results: requests.map((r) => ({
        customId: r.customId,
        status: "succeeded",
        text: "{}",
        stopReason: "end_turn",
      })),
      costUsd: 0,
    }));
    const requests = Array.from({ length: 2001 }, (_, i) =>
      buildLocationRequest(`p${i}`, { raw: `s${i}` }),
    );

    const answers = await createLocationModel().batch(requests);

    expect(llm.batchGenerate).toHaveBeenCalledTimes(2);
    expect(llm.batchGenerate.mock.calls[1]![0]).toHaveLength(1);
    expect(llm.batchGenerate.mock.calls[0]![0][0]).toMatchObject({
      customId: "p0",
      model: "haiku",
      effort: "low",
      thinking: "off",
      cacheSystem: true,
      schema: LocationAnswerSchema,
    });
    expect(answers.size).toBe(2001);
    expect(answers.get("p2000")).toEqual({ status: "answered", text: "{}" });
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
