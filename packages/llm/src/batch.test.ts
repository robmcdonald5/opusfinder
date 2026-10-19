import { describe, expect, it } from "vitest";

import { batchGenerate, submitBatch, type BatchRequest } from "./batch";

// Pure unit for batch.ts's INPUT GUARDS, which run before any key or network access: an empty list, every
// malformed/duplicate customId, and a mixed-tier batch throw before the submit. A duplicate id would
// collapse the customId→result map and mis-correlate one request's completion onto another; a mixed-tier
// list can't be one OpenRouter batch (it has one model). No env is stubbed: a correct guard never reaches
// the transport (the unit project's fetch throws).

const baseRequest = Object.freeze<Omit<BatchRequest, "customId">>({
  model: "haiku",
  messages: [{ role: "user", content: "hi" }],
});

function req(customId: string, overrides: Partial<BatchRequest> = {}): BatchRequest {
  return { ...baseRequest, customId, ...overrides };
}

describe("submitBatch input guards (pre-network)", () => {
  it("throws on an empty request list", async () => {
    await expect(submitBatch([])).rejects.toThrow("submitBatch: received no requests.");
  });

  // ^[a-zA-Z0-9_-]{1,64}$ — anything outside the alnum/_/- alphabet, empty, or >64 chars is rejected.
  it.each([
    ["", "empty"],
    [" ", "whitespace-only (not trimmed)"],
    ["has space", "embedded space"],
    ["dot.id", "dot"],
    ["slash/id", "slash"],
    ["colon:id", "colon"],
    ["café", "non-ASCII letter"],
    ["emoji\u{1F600}", "astral/emoji"],
    ["line\nbreak", "embedded newline (anchored $ must not match before a trailing newline)"],
    ["a".repeat(65), "65 chars (one over the 64 max)"],
  ])("throws on malformed customId %j (%s)", async (customId) => {
    await expect(submitBatch([req(customId)])).rejects.toThrow(
      `submitBatch: customId "${customId}" must match ^[a-zA-Z0-9_-]{1,64}$.`,
    );
  });

  it("throws on a duplicate customId within the batch", async () => {
    await expect(submitBatch([req("job-1"), req("job-1")])).rejects.toThrow(
      'submitBatch: duplicate customId "job-1" (must be unique within a batch).',
    );
  });

  it("reports the malformed id before the duplicate check when both ids are bad", async () => {
    await expect(submitBatch([req("bad id"), req("bad id")])).rejects.toThrow(
      'submitBatch: customId "bad id" must match',
    );
  });

  it("throws on a batch that mixes model tiers", async () => {
    await expect(submitBatch([req("a"), req("b", { model: "sonnet" })])).rejects.toThrow(
      "submitBatch: a batch runs one model; got haiku, sonnet.",
    );
  });

  it("throws on a setting the Batch API would reject after accepting the batch", async () => {
    await expect(submitBatch([req("a", { model: "sonnet", thinking: "off" })])).rejects.toThrow(
      /the Batch API rejects sonnet's thinking-off setting/,
    );
  });
});

describe("batchGenerate empty short-circuit (pre-network)", () => {
  it("returns no results without submitting when given no requests", async () => {
    await expect(batchGenerate([])).resolves.toEqual({ results: [], costUsd: 0 });
  });
});
