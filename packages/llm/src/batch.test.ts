import { describe, expect, it } from "vitest";

import type { ModelMessage } from "ai";

import { batchGenerate, submitBatch, type BatchRequest } from "./batch";

// Phase 1 leaf pure-unit. batch.ts is mostly HTTP (submit/poll/collect → Phase 3), but its INPUT GUARDS
// run before any client/key/network access and are load-bearing: submitBatch rejects an empty list and
// every malformed/duplicate customId BEFORE getClient() is ever called, and batchGenerate short-circuits
// an empty request list. The customId guard is the fail-fast that (a) avoids Anthropic's opaque 400 on a
// bad id and (b) stops a duplicate id from collapsing the customId→result map and mis-correlating one
// request's completion onto another. These tests exercise only those pre-network throw/return paths — no
// env is stubbed and no SDK is mocked precisely because a correct guard never reaches the client.

// Frozen base fixture; only customId varies per case. `messages: []` is never inspected on these paths
// (toAnthropicMessages runs inside the create() call, after the guards).
const baseRequest = Object.freeze<Omit<BatchRequest, "customId">>({
  model: "haiku",
  messages: [] as ModelMessage[],
});

function req(customId: string): BatchRequest {
  return { ...baseRequest, customId };
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
      `batchGenerate: customId "${customId}" must match ^[a-zA-Z0-9_-]{1,64}$.`,
    );
  });

  it("throws on a duplicate customId within the batch", async () => {
    await expect(submitBatch([req("job-1"), req("job-1")])).rejects.toThrow(
      'batchGenerate: duplicate customId "job-1" (must be unique within a batch).',
    );
  });

  it("reports the malformed id before the duplicate check when both ids are bad", async () => {
    // Pattern is validated per-element first, so a malformed pair surfaces the pattern error, not duplicate.
    await expect(submitBatch([req("bad id"), req("bad id")])).rejects.toThrow(
      'batchGenerate: customId "bad id" must match',
    );
  });
});

describe("batchGenerate empty short-circuit (pre-network)", () => {
  it("returns [] without submitting when given no requests", async () => {
    await expect(batchGenerate([])).resolves.toEqual([]);
  });
});
