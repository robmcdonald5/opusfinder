import type { RerankCandidate } from "@opusfinder/rerank";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RerankScoresSchema, renderRerankCandidates } from "@opusfinder/llm";

import { callModel, ModelReplyError, type ModelRoute } from "../model-caller";
import { modelRerankCall } from "./model-rerank";

// The rerank call built on the eval's caller, with the caller itself mocked. Pins that it asks what the
// digest's rerank asks (the cached system, the rendered chunk, the score schema, low effort, the 4096 cap)
// on the given route, reports every reply's cost, leaves an unusable chunk unscored as the digest does,
// and lets a reply from an unpinned host fail the run.
vi.mock("../model-caller", async (original) => ({
  ...(await original<typeof import("../model-caller")>()),
  callModel: vi.fn(),
}));

const ROUTE: ModelRoute = { model: "deepseek/deepseek-v4.1-flash", hosts: ["deepinfra/fp8"] };
const CHUNK: RerankCandidate[] = [
  { id: 7, title: "Backend Engineer", descriptionText: "Go services" },
  { id: 9, title: "Account Executive", descriptionText: "Enterprise sales" },
];
const USAGE = {
  inputTokens: 900,
  outputTokens: 60,
  reasoningTokens: 20,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.0002,
};
const SERVED = { host: "DeepInfra", model: "deepseek/deepseek-v4.1-flash-20260910" };

describe("modelRerankCall", () => {
  afterEach(() => vi.mocked(callModel).mockReset());

  it("sends the digest's rerank request on the route and returns the scores", async () => {
    vi.mocked(callModel).mockResolvedValue({
      object: {
        scores: [
          { id: 7, score: 0.9 },
          { id: 9, score: 0.05 },
        ],
      },
      usage: USAGE,
      host: SERVED.host,
      servedModel: SERVED.model,
    });
    const replies: unknown[] = [];

    const scores = await modelRerankCall(ROUTE, { onReply: (r) => replies.push(r) })(
      "rubric + profile",
      CHUNK,
    );

    expect(scores).toEqual([
      { id: 7, score: 0.9 },
      { id: 9, score: 0.05 },
    ]);
    expect(vi.mocked(callModel).mock.calls).toEqual([
      [
        {
          route: ROUTE,
          system: "rubric + profile",
          cacheSystem: true,
          schema: RerankScoresSchema,
          schemaName: "rerank_scores",
          messages: [{ role: "user", content: renderRerankCandidates(CHUNK) }],
          reasoningEffort: "low",
          maxOutputTokens: 4096,
        },
      ],
    ]);
    expect(replies).toEqual([{ usage: USAGE, served: SERVED }]);
  });

  it("passes a chosen effort through", async () => {
    vi.mocked(callModel).mockResolvedValue({
      object: { scores: [] },
      usage: USAGE,
      host: SERVED.host,
      servedModel: SERVED.model,
    });

    await modelRerankCall(ROUTE, { effort: "none" })("system", CHUNK);

    expect(vi.mocked(callModel).mock.calls[0]?.[0].reasoningEffort).toBe("none");
  });

  it("leaves a chunk with an unusable reply unscored, and still reports its cost", async () => {
    vi.mocked(callModel).mockRejectedValue(
      new ModelReplyError("truncated", "output was truncated", { spent: USAGE, served: SERVED }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const replies: unknown[] = [];

    const scores = await modelRerankCall(ROUTE, { onReply: (r) => replies.push(r) })(
      "system",
      CHUNK,
    );

    expect(scores).toEqual([]);
    expect(replies).toEqual([{ usage: USAGE, served: SERVED }]);
    expect(warn).toHaveBeenCalledWith(
      "rerank: chunk left unscored (jobs 7,9): output was truncated",
    );
    warn.mockRestore();
  });

  it("fails the run on a reply from an unpinned host", async () => {
    const unpinned = new ModelReplyError("unpinned_host", "served by Novita", {
      spent: USAGE,
      served: { host: "Novita", model: SERVED.model },
    });
    vi.mocked(callModel).mockRejectedValue(unpinned);

    await expect(modelRerankCall(ROUTE)("system", CHUNK)).rejects.toBe(unpinned);
  });

  it("rethrows a provider or network failure", async () => {
    const down = new Error("fetch failed");
    vi.mocked(callModel).mockRejectedValue(down);

    await expect(modelRerankCall(ROUTE)("system", CHUNK)).rejects.toBe(down);
  });
});
