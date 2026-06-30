import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  assertMaxOutputTokens,
  assertSystemNotInMessages,
  buildCacheableRequest,
  readCacheCounters,
} from "./cache-plumbing";

// Leaf pure-unit. These four helpers are the load-bearing seam for Anthropic prompt caching: the two
// guards fail at the boundary so a misplaced system prompt can't silently shrink the cached prefix or
// throw deep in the SDK, buildCacheableRequest decides WHERE the cacheControl breakpoint lands, and
// readCacheCounters normalizes the split write/read counters. A regression here corrupts caching cost
// accounting or breaks generate() with no obvious symptom — so the request shape and counter math are
// locked exactly. Ports the cache-plumbing concerns out of scripts/test-llm.ts (HTTP/live stays there).

// Frozen fixtures — deterministic, never re-derived per run.
const USER_MESSAGE: ModelMessage = { role: "user", content: "find me a role" };
const ASSISTANT_MESSAGE: ModelMessage = { role: "assistant", content: "sure" };
const BASE_MESSAGES: ModelMessage[] = [USER_MESSAGE, ASSISTANT_MESSAGE];

describe("assertSystemNotInMessages", () => {
  it("passes when no message carries role:system", () => {
    expect(() => assertSystemNotInMessages("generate", BASE_MESSAGES)).not.toThrow();
  });

  it("passes on an empty message list", () => {
    expect(() => assertSystemNotInMessages("generate", [])).not.toThrow();
  });

  it("throws naming the caller when any message is role:system", () => {
    const messages: ModelMessage[] = [
      USER_MESSAGE,
      { role: "system", content: "you are helpful" },
    ];
    expect(() => assertSystemNotInMessages("generateObject", messages)).toThrowError(
      /generateObject\(\): pass the system prompt via the `system` option/,
    );
  });

  it("throws even when the system entry is non-leading (would crash the converter)", () => {
    const messages: ModelMessage[] = [
      USER_MESSAGE,
      ASSISTANT_MESSAGE,
      { role: "system", content: "trailing system" },
    ];
    expect(() => assertSystemNotInMessages("generate", messages)).toThrow();
  });
});

describe("assertMaxOutputTokens", () => {
  it.each([1, 2, 1024, Number.MAX_SAFE_INTEGER])(
    "%j is an allowed positive budget",
    (value) => {
      expect(() => assertMaxOutputTokens("generate", value)).not.toThrow();
    },
  );

  it("allows undefined (no budget specified)", () => {
    expect(() => assertMaxOutputTokens("generate", undefined)).not.toThrow();
  });

  it.each([0, 0.5, -1, -1000])("%j (< 1) throws naming the caller and the value", (value) => {
    expect(() => assertMaxOutputTokens("generateObject", value)).toThrowError(
      new RegExp(`generateObject\\(\\): maxOutputTokens must be >= 1 \\(got ${value}\\)`),
    );
  });
});

describe("buildCacheableRequest", () => {
  it("passes the plain system through when caching is not requested", () => {
    const result = buildCacheableRequest({
      system: "you are helpful",
      cacheSystem: false,
      messages: BASE_MESSAGES,
    });
    expect(result).toEqual({
      system: "you are helpful",
      messages: BASE_MESSAGES,
      extra: {},
    });
  });

  it("passes through (no promotion) when cacheSystem is omitted", () => {
    const result = buildCacheableRequest({ system: "sys", messages: BASE_MESSAGES });
    expect(result.system).toBe("sys");
    expect(result.extra).toEqual({});
  });

  it("does NOT promote when caching is requested but there is no system prompt", () => {
    const result = buildCacheableRequest({ cacheSystem: true, messages: BASE_MESSAGES });
    // No system string → nothing to cache; messages stay untouched and no flag leaks through.
    expect(result.system).toBeUndefined();
    expect(result.messages).toEqual(BASE_MESSAGES);
    expect(result.extra).toEqual({});
  });

  it("does NOT promote an empty-string system (falsy → nothing to cache)", () => {
    const result = buildCacheableRequest({ system: "", cacheSystem: true, messages: BASE_MESSAGES });
    expect(result.system).toBe("");
    expect(result.messages).toEqual(BASE_MESSAGES);
    expect(result.extra).toEqual({});
  });

  it("promotes the system to a leading cache-marked message when caching is requested", () => {
    const result = buildCacheableRequest({
      system: "you are helpful",
      cacheSystem: true,
      messages: BASE_MESSAGES,
    });

    // system option is cleared — it now lives in messages so it can carry a cacheControl breakpoint.
    expect(result.system).toBeUndefined();
    expect(result.extra).toEqual({ allowSystemInMessages: true });

    // The cache-marked system message must be FIRST (the breakpoint covers the leading prefix).
    expect(result.messages[0]).toEqual({
      role: "system",
      content: "you are helpful",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    // The original messages follow, in order, after the promoted system.
    expect(result.messages.slice(1)).toEqual(BASE_MESSAGES);
  });

  it("does not mutate the caller's messages array when promoting", () => {
    const messages: ModelMessage[] = [USER_MESSAGE];
    buildCacheableRequest({ system: "sys", cacheSystem: true, messages });
    expect(messages).toEqual([USER_MESSAGE]); // still length 1, untouched
  });
});

describe("readCacheCounters", () => {
  it("reads both counters off a fully-populated Anthropic result", () => {
    const result = {
      providerMetadata: { anthropic: { cacheCreationInputTokens: 128 } },
      usage: { cachedInputTokens: 64 },
    };
    expect(readCacheCounters(result)).toEqual({
      creationInputTokens: 128,
      readInputTokens: 64,
    });
  });

  it("defaults to 0 for a non-Anthropic provider (no anthropic metadata)", () => {
    const result = { providerMetadata: { openai: {} }, usage: {} };
    expect(readCacheCounters(result)).toEqual({
      creationInputTokens: 0,
      readInputTokens: 0,
    });
  });

  it("defaults to 0 when providerMetadata is absent entirely", () => {
    expect(readCacheCounters({ usage: { cachedInputTokens: 0 } })).toEqual({
      creationInputTokens: 0,
      readInputTokens: 0,
    });
  });

  it("defaults to 0 when providerMetadata is null (optional-chaining survives malformed input)", () => {
    expect(readCacheCounters({ providerMetadata: null, usage: { cachedInputTokens: 0 } })).toEqual({
      creationInputTokens: 0,
      readInputTokens: 0,
    });
  });

  it("reads the cachedInputTokens read counter when usage carries no value (defaults to 0)", () => {
    const result = {
      providerMetadata: { anthropic: { cacheCreationInputTokens: 7 } },
      usage: {},
    };
    expect(readCacheCounters(result)).toEqual({ creationInputTokens: 7, readInputTokens: 0 });
  });

  it.each([
    ["a non-number creation counter", { cacheCreationInputTokens: "128" }],
    ["NaN", { cacheCreationInputTokens: Number.NaN }],
    ["Infinity", { cacheCreationInputTokens: Number.POSITIVE_INFINITY }],
    ["null", { cacheCreationInputTokens: null }],
    ["a missing field", {}],
  ])("coerces %s to 0", (_label, anthropic) => {
    const result = {
      providerMetadata: { anthropic },
      usage: { cachedInputTokens: 5 },
    };
    expect(readCacheCounters(result).creationInputTokens).toBe(0);
  });

  it("coerces a non-finite cachedInputTokens read counter to 0", () => {
    const result = {
      providerMetadata: { anthropic: { cacheCreationInputTokens: 10 } },
      usage: { cachedInputTokens: Number.NaN },
    };
    expect(readCacheCounters(result).readInputTokens).toBe(0);
  });
});
