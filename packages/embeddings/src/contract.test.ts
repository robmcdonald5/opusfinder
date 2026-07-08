import { afterEach, describe, expect, it, vi } from "vitest";

import { EMBEDDING_DIMENSIONS } from "@opusfinder/db/schema";

import { chunkByLimits, parseEmbeddingResponse } from "./contract";
import { getVoyageApiKey } from "./env";
import { EMBED_DIMENSIONS, estimateCostUsd, formatEmbedCost } from "./provider";

// The provider-agnostic embedding contract (request chunking + response-envelope validation) plus the
// pure cost helpers and the env-key guard. All HTTP-free — the Voyage wire path is covered separately in
// embed.integration.test.ts (MSW). No 1024 literals: widths come from the schema constant.

const collect = (texts: string[], limits: Parameters<typeof chunkByLimits>[1]): string[][] => [
  ...chunkByLimits(texts, limits),
];

describe("chunkByLimits", () => {
  const limits = { maxItems: 128, maxTokens: 90_000, charsPerToken: 3 };

  it("keeps everything in one chunk when under both caps, order preserved", () => {
    expect(collect(["a", "bb", "ccc"], limits)).toEqual([["a", "bb", "ccc"]]);
  });

  it("splits on the item cap and preserves order across the boundary", () => {
    const texts = Array.from({ length: 129 }, (_, i) => `t${i}`); // short → token cap never bites
    const out = collect(texts, limits);
    expect(out.map((c) => c.length)).toEqual([128, 1]);
    expect(out.flat()).toEqual(texts);
  });

  it("splits on the token budget, treating '== maxTokens' as NOT exceeding", () => {
    // charsPerToken 1 → 1 token/char. Two 5-char texts sum to exactly 10 (== cap → stay together);
    // the third tips the running total to 11 (> cap → split). Pins the strict `>` boundary.
    const tiny = { maxItems: 100, maxTokens: 10, charsPerToken: 1 };
    expect(collect(["aaaaa", "bbbbb", "c"], tiny)).toEqual([["aaaaa", "bbbbb"], ["c"]]);
  });

  it("emits an oversized lone input as its own chunk (never dropped or merged)", () => {
    const tiny = { maxItems: 100, maxTokens: 10, charsPerToken: 1 };
    const big = "x".repeat(20); // 20 est-tokens, alone over the 10 cap
    expect(collect([big, "y"], tiny)).toEqual([[big], ["y"]]);
  });

  it("yields nothing for empty input", () => {
    expect(collect([], limits)).toEqual([]);
  });
});

describe("parseEmbeddingResponse", () => {
  const opts = { provider: "Voyage", expectedDimensions: 3, expectedCount: 2 };
  const vecA = [0.1, 0.2, 0.3];
  const vecB = [0.4, 0.5, 0.6];

  it("extracts order-aligned vectors and usage on the happy path", () => {
    const body = {
      data: [
        { embedding: vecA, index: 0 },
        { embedding: vecB, index: 1 },
      ],
      usage: { total_tokens: 42 },
    };
    expect(parseEmbeddingResponse(body, opts)).toEqual({ embeddings: [vecA, vecB], totalTokens: 42 });
  });

  it("reassembles ascending by index when data arrives out of order (the defensive sort)", () => {
    const body = {
      data: [
        { embedding: vecB, index: 1 },
        { embedding: vecA, index: 0 },
      ],
    };
    expect(parseEmbeddingResponse(body, opts).embeddings).toEqual([vecA, vecB]);
  });

  it("falls back to array position when index is missing", () => {
    const body = { data: [{ embedding: vecA }, { embedding: vecB }] };
    expect(parseEmbeddingResponse(body, opts).embeddings).toEqual([vecA, vecB]);
  });

  it("defaults totalTokens to 0 when usage is missing or non-finite", () => {
    const base = {
      data: [
        { embedding: vecA, index: 0 },
        { embedding: vecB, index: 1 },
      ],
    };
    expect(parseEmbeddingResponse(base, opts).totalTokens).toBe(0);
    expect(parseEmbeddingResponse({ ...base, usage: { total_tokens: Number.NaN } }, opts).totalTokens).toBe(0);
    expect(parseEmbeddingResponse({ ...base, usage: { total_tokens: Infinity } }, opts).totalTokens).toBe(0);
  });

  it.each([
    { name: "a body with no data array", body: {}, msg: "Voyage embeddings response missing a `data` array." },
    { name: "data that is not an array", body: { data: "nope" }, msg: "Voyage embeddings response missing a `data` array." },
    { name: "an item missing its vector", body: { data: [{ index: 0 }] }, msg: "Voyage embeddings response item 0 is missing its vector." },
    { name: "a wrong-width vector", body: { data: [{ embedding: [1, 2], index: 0 }] }, msg: "Voyage returned a 2-dim vector for item 0; expected 3." },
    { name: "a NaN component", body: { data: [{ embedding: [1, 2, Number.NaN], index: 0 }] }, msg: "Voyage returned a non-finite embedding component for item 0." },
    { name: "an Infinity component", body: { data: [{ embedding: [1, 2, Infinity], index: 0 }] }, msg: "Voyage returned a non-finite embedding component for item 0." },
  ])("throws the exact message on $name", ({ body, msg }) => {
    expect(() => parseEmbeddingResponse(body, opts)).toThrow(msg);
  });

  it("throws when the returned count does not match the inputs sent", () => {
    const body = { data: [{ embedding: vecA, index: 0 }] }; // one valid vector, expectedCount is 2
    expect(() => parseEmbeddingResponse(body, opts)).toThrow("Voyage returned 1 embeddings for 2 inputs.");
  });
});

describe("cost helpers", () => {
  it("estimateCostUsd scales linearly at the pinned list price", () => {
    expect(estimateCostUsd(0)).toBe(0);
    expect(estimateCostUsd(1_000_000)).toBeCloseTo(0.12, 10);
    expect(estimateCostUsd(76_486)).toBeCloseTo(0.00917832, 10);
  });

  it("formatEmbedCost pins the exact 4-decimal log suffix", () => {
    expect(formatEmbedCost(76_486)).toBe("76486 tokens, ~$0.0092");
    expect(formatEmbedCost(0)).toBe("0 tokens, ~$0.0000");
  });

  it("the provider's hardcoded EMBED_DIMENSIONS matches the db schema width", () => {
    // Guards the documented divergence risk: a vector wider/narrower than the column fails the
    // ::vector(N) cast at write time with an opaque error.
    expect(EMBED_DIMENSIONS).toBe(EMBEDDING_DIMENSIONS);
  });
});

describe("getVoyageApiKey guard", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throws the friendly not-set message when VOYAGE_API_KEY is blank", () => {
    vi.stubEnv("VOYAGE_API_KEY", "");
    expect(() => getVoyageApiKey()).toThrow("VOYAGE_API_KEY is not set.");
  });

  it("returns the key without warning when the prefix matches", () => {
    vi.stubEnv("VOYAGE_API_KEY", "pa-abc123");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getVoyageApiKey()).toBe("pa-abc123");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns (secret-free) but still returns the key on a wrong prefix", () => {
    vi.stubEnv("VOYAGE_API_KEY", "sk-wrongprefix"); // length 14
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getVoyageApiKey()).toBe("sk-wrongprefix");
    expect(warn).toHaveBeenCalledOnce();
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("length 14");
    expect(message).not.toContain("sk-wrongprefix"); // echoes shape, never the value
    warn.mockRestore();
  });
});
