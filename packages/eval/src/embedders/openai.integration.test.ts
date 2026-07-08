import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMBED_DIMENSIONS } from "@opusfinder/embeddings";
import { oneHot } from "@test/db/vectors";
import { embeddingsEnvelope } from "@test/msw/fixtures/embeddings";
import { server } from "@test/msw/server";

import { openaiEmbedder } from "./openai";

// The eval-only OpenAI embedder (openai.ts → global fetch) over MSW. Unlike the shipped Voyage embedder
// it has NO key-injection seam — it always reads OPENAI_API_KEY via requireEnv (per call), so each test
// stubs the env. What's eval-LOCAL and otherwise uncovered: the request contract (model +
// `dimensions: EMBED_DIMENSIONS`, inputType IGNORED), the per-input char truncation, the chunk
// reassembly across >128 inputs, the no-retry error path (secret-free snippet), and the wiring into the
// shared parseEmbeddingResponse contract (provider="OpenAI", expectedDimensions/expectedCount). The
// chunker + parser INVARIANTS themselves live in @opusfinder/embeddings' own suites; here only the
// OpenAI wiring around them is asserted. onUnhandledRequest:"error" proves zero live egress.

const OPENAI_URL = "https://api.openai.com/v1/embeddings";
const KEY = "sk-test-key";

describe("openaiEmbedder — OpenAI embeddings over MSW", () => {
  beforeEach(() => vi.stubEnv("OPENAI_API_KEY", KEY));
  afterEach(() => vi.unstubAllEnvs());

  it("sends the exact OpenAI request contract (model + dimensions; inputType ignored)", async () => {
    let method = "";
    let auth: string | null = null;
    let contentType: string | null = null;
    let body: unknown;
    server.use(
      http.post(OPENAI_URL, async ({ request }) => {
        method = request.method;
        auth = request.headers.get("authorization");
        contentType = request.headers.get("content-type");
        body = await request.json();
        return HttpResponse.json(embeddingsEnvelope(1));
      }),
    );

    await openaiEmbedder(["hello world"], "document");

    expect(method).toBe("POST");
    expect(auth).toBe(`Bearer ${KEY}`);
    expect(contentType).toContain("application/json");
    // OpenAI is symmetric → inputType is dropped (no input_type field, unlike Voyage).
    expect(body).toEqual({
      model: "text-embedding-3-small",
      input: ["hello world"],
      dimensions: EMBED_DIMENSIONS,
    });
  });

  it("ignores inputType — 'query' and 'document' produce byte-identical request bodies", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(OPENAI_URL, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(embeddingsEnvelope(1));
      }),
    );

    await openaiEmbedder(["x"], "query");
    await openaiEmbedder(["x"], "document");

    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).not.toHaveProperty("input_type");
  });

  it("reads the key from OPENAI_API_KEY at call time (a re-stub changes the Authorization header)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-rotated-key");
    let auth: string | null = null;
    server.use(
      http.post(OPENAI_URL, ({ request }) => {
        auth = request.headers.get("authorization");
        return HttpResponse.json(embeddingsEnvelope(1));
      }),
    );

    await openaiEmbedder(["x"], null);

    expect(auth).toBe("Bearer sk-rotated-key");
  });

  it("truncates each input to the per-input char budget, leaving short inputs untouched", async () => {
    let input: string[] = [];
    server.use(
      http.post(OPENAI_URL, async ({ request }) => {
        input = ((await request.json()) as { input: string[] }).input;
        return HttpResponse.json(embeddingsEnvelope(input.length));
      }),
    );

    const long = "a".repeat(25_000); // over OpenAI's ~8k-token per-input limit
    await openaiEmbedder([long, "short"], "document");

    expect(input[0]).toHaveLength(24_000); // MAX_TOKENS_PER_INPUT(8000) * CHARS_PER_TOKEN(3)
    expect(input[1]).toBe("short"); // a short input is passed through verbatim
  });

  it("reassembles vectors 1:1 in input order across >128-input chunk boundaries", async () => {
    // 129 inputs > MAX_ITEMS_PER_REQUEST(128) → two POSTs of [128, 1]. Each input encodes its GLOBAL
    // index and the handler returns a one-hot at that index, so an off-by-a-chunk reassembly bug misaligns.
    let calls = 0;
    const perRequest: number[] = [];
    server.use(
      http.post(OPENAI_URL, async ({ request }) => {
        calls += 1;
        const b = (await request.json()) as { input: string[] };
        perRequest.push(b.input.length);
        return HttpResponse.json({
          data: b.input.map((text, i) => ({ embedding: oneHot(Number(text.slice(4))), index: i })),
          usage: { total_tokens: b.input.length },
        });
      }),
    );

    const inputs = Array.from({ length: 129 }, (_item, i) => `idx-${i}`);
    const vectors = await openaiEmbedder(inputs, "document");

    expect(calls).toBe(2);
    expect(perRequest).toEqual([128, 1]);
    expect(vectors).toEqual([...inputs.keys()].map((k) => oneHot(k)));
  });

  it("returns order-aligned vectors on the happy path (usage discarded)", async () => {
    server.use(
      http.post(OPENAI_URL, async ({ request }) => {
        const b = (await request.json()) as { input: string[] };
        return HttpResponse.json(embeddingsEnvelope(b.input.length, { totalTokens: 99 }));
      }),
    );

    const vectors = await openaiEmbedder(["a", "b"], "document");

    // The Embedder contract returns vectors only — usage (99) is intentionally dropped by this embedder.
    expect(vectors).toEqual([oneHot(0), oneHot(1)]);
    expect(vectors[0]).toHaveLength(EMBED_DIMENSIONS);
  });

  it("short-circuits an empty input list with ZERO network calls", async () => {
    let calls = 0;
    server.use(
      http.post(OPENAI_URL, () => {
        calls += 1;
        return HttpResponse.json(embeddingsEnvelope(0));
      }),
    );

    const vectors = await openaiEmbedder([], "document");

    expect(calls).toBe(0);
    expect(vectors).toEqual([]);
  });

  it("throws a secret-free error on a non-2xx, echoing status + a ≤300-char snippet", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-secret-DEADBEEF");
    server.use(http.post(OPENAI_URL, () => HttpResponse.text("E".repeat(400), { status: 500 })));

    let err: Error | undefined;
    try {
      await openaiEmbedder(["x"], "document");
    } catch (e) {
      err = e as Error;
    }

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/OpenAI embeddings request failed: 500/);
    expect(err?.message).not.toContain("sk-secret-DEADBEEF"); // no-secrets-in-errors
    expect(err?.message).toContain("E".repeat(300)); // snippet sliced to 300
    expect(err?.message).not.toContain("E".repeat(301));
  });

  it("omits the ' - snippet' suffix when the error body is empty", async () => {
    server.use(http.post(OPENAI_URL, () => new HttpResponse(null, { status: 503 })));

    let err: Error | undefined;
    try {
      await openaiEmbedder(["x"], "document");
    } catch (e) {
      err = e as Error;
    }

    expect(err?.message).toMatch(/OpenAI embeddings request failed: 503/);
    expect(err?.message).not.toContain(" - ");
  });

  it("does NOT retry a 429 — exactly one request fires", async () => {
    let calls = 0;
    server.use(
      http.post(OPENAI_URL, () => {
        calls += 1;
        return HttpResponse.text("rate limited", { status: 429 });
      }),
    );

    await expect(openaiEmbedder(["x"], "document")).rejects.toThrow(
      /OpenAI embeddings request failed: 429/,
    );
    expect(calls).toBe(1);
  });

  it("surfaces the OpenAI provider label + expected width from parseEmbeddingResponse on a bad vector", async () => {
    // A wrong-width vector proves the eval-local wiring: provider="OpenAI" + expectedDimensions=EMBED_DIMENSIONS.
    server.use(
      http.post(OPENAI_URL, () =>
        HttpResponse.json({
          data: [{ embedding: new Array(512).fill(0), index: 0 }],
          usage: { total_tokens: 1 },
        }),
      ),
    );

    await expect(openaiEmbedder(["x"], "document")).rejects.toThrow(
      new RegExp(`OpenAI returned a 512-dim vector for item 0; expected ${EMBED_DIMENSIONS}\\.`),
    );
  });

  it("enforces expectedCount = input length (a count mismatch throws)", async () => {
    // One input but two vectors back → the expectedCount:input.length wiring rejects the misaligned response.
    server.use(http.post(OPENAI_URL, () => HttpResponse.json(embeddingsEnvelope(2))));

    await expect(openaiEmbedder(["only-one"], "document")).rejects.toThrow(
      /OpenAI returned 2 embeddings for 1 inputs\./,
    );
  });
});
