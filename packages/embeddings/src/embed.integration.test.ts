import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EMBEDDING_DIMENSIONS } from "@opusfinder/db/schema";
import { oneHot } from "@test/db/vectors";
import { embeddingsEnvelope } from "@test/msw/fixtures/embeddings";
import { server } from "@test/msw/server";

import { embed } from "./embed";

// The Voyage HTTP boundary (embed() → embedRequest() → global fetch), intercepted by MSW. This is the
// repo's first POST-BODY assertion: the fetch-router is URL-only, so the request-shape checks below
// (method / Authorization / body) need MSW. onUnhandledRequest:"error" (the integration setup) proves
// zero live egress — any URL these suites don't handle would hard-fail.

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

describe("embed — Voyage over MSW", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sends the exact Voyage request contract", async () => {
    let method = "";
    let auth: string | null = null;
    let contentType: string | null = null;
    let body: unknown;
    server.use(
      http.post(VOYAGE_URL, async ({ request }) => {
        method = request.method;
        auth = request.headers.get("authorization");
        contentType = request.headers.get("content-type");
        body = await request.json();
        return HttpResponse.json(embeddingsEnvelope(1));
      }),
    );

    await embed(["hello world"], { inputType: "document", apiKey: "pa-explicit" });

    expect(method).toBe("POST");
    expect(auth).toBe("Bearer pa-explicit");
    expect(contentType).toContain("application/json");
    expect(body).toEqual({
      model: "voyage-4-large",
      input: ["hello world"],
      input_type: "document",
      output_dimension: EMBEDDING_DIMENSIONS,
    });
  });

  it("returns order-aligned vectors, the response usage, and the model on the happy path", async () => {
    server.use(
      http.post(VOYAGE_URL, async ({ request }) => {
        const b = (await request.json()) as { input: string[] };
        return HttpResponse.json(embeddingsEnvelope(b.input.length, { totalTokens: 55 }));
      }),
    );

    const result = await embed(["a", "b"], { apiKey: "pa-key" });

    expect(result.model).toBe("voyage-4-large");
    expect(result.usage.totalTokens).toBe(55);
    expect(result.embeddings).toEqual([oneHot(0), oneHot(1)]);
    expect(result.embeddings[0]).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("defaults input_type to null when omitted", async () => {
    let body: { input_type?: unknown } | undefined;
    server.use(
      http.post(VOYAGE_URL, async ({ request }) => {
        body = (await request.json()) as { input_type?: unknown };
        return HttpResponse.json(embeddingsEnvelope(1));
      }),
    );

    await embed(["x"], { apiKey: "pa-key" });

    expect(body?.input_type).toBeNull();
  });

  it("short-circuits embed([]) with ZERO network calls", async () => {
    let calls = 0;
    server.use(
      http.post(VOYAGE_URL, async ({ request }) => {
        calls += 1;
        const b = (await request.json()) as { input: string[] };
        return HttpResponse.json(embeddingsEnvelope(b.input.length));
      }),
    );

    const result = await embed([], { apiKey: "pa-key" });

    expect(calls).toBe(0);
    expect(result).toEqual({ embeddings: [], usage: { totalTokens: 0 }, model: "voyage-4-large" });
  });

  it("reassembles vectors 1:1 in input order across chunk boundaries and sums usage", async () => {
    // 129 inputs > MAX_ITEMS_PER_REQUEST (128) → two POSTs of [128, 1]. Each input encodes its GLOBAL
    // index, and the handler returns a one-hot at that index, so an off-by-a-chunk reassembly bug would
    // misalign the final array. Distinct per-request usage proves the sum, not a single-response read.
    let calls = 0;
    const perRequest: number[] = [];
    server.use(
      http.post(VOYAGE_URL, async ({ request }) => {
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
    const result = await embed(inputs, { apiKey: "pa-key" });

    expect(calls).toBe(2);
    expect(perRequest).toEqual([128, 1]);
    expect(result.usage.totalTokens).toBe(129);
    expect(result.embeddings).toEqual([...inputs.keys()].map((k) => oneHot(k)));
  });

  it("uses an explicitly injected key and does NOT read the env in that path", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "pa-envkey-should-not-be-used");
    let auth: string | null = null;
    server.use(
      http.post(VOYAGE_URL, async ({ request }) => {
        auth = request.headers.get("authorization");
        const b = (await request.json()) as { input: string[] };
        return HttpResponse.json(embeddingsEnvelope(b.input.length));
      }),
    );

    await embed(["x"], { apiKey: "pa-explicit" });

    expect(auth).toBe("Bearer pa-explicit");
  });

  it("falls back to the env key when the injected key is empty (never a bare 'Bearer ')", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "pa-envkey");
    let auth: string | null = null;
    server.use(
      http.post(VOYAGE_URL, async ({ request }) => {
        auth = request.headers.get("authorization");
        const b = (await request.json()) as { input: string[] };
        return HttpResponse.json(embeddingsEnvelope(b.input.length));
      }),
    );

    await embed(["x"], { apiKey: "" });

    expect(auth).toBe("Bearer pa-envkey");
    expect(auth).not.toBe("Bearer ");
  });

  it("throws a secret-free error on a non-2xx, echoing status + a ≤300-char snippet", async () => {
    server.use(http.post(VOYAGE_URL, () => HttpResponse.text("E".repeat(400), { status: 500 })));

    let err: Error | undefined;
    try {
      await embed(["x"], { apiKey: "pa-secret" });
    } catch (e) {
      err = e as Error;
    }

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/Voyage embeddings request failed: 500/);
    expect(err?.message).not.toContain("pa-secret"); // no-secrets-in-errors
    expect(err?.message).toContain("E".repeat(300)); // snippet is sliced to 300
    expect(err?.message).not.toContain("E".repeat(301));
  });

  it("omits the ' - snippet' suffix when the error body is empty", async () => {
    server.use(http.post(VOYAGE_URL, () => new HttpResponse(null, { status: 503 })));

    let err: Error | undefined;
    try {
      await embed(["x"], { apiKey: "pa-key" });
    } catch (e) {
      err = e as Error;
    }

    expect(err?.message).toMatch(/Voyage embeddings request failed: 503/);
    expect(err?.message).not.toContain(" - ");
  });

  it("does NOT retry a 429 — exactly one request fires", async () => {
    let calls = 0;
    server.use(
      http.post(VOYAGE_URL, () => {
        calls += 1;
        return HttpResponse.text("rate limited", { status: 429 });
      }),
    );

    await expect(embed(["x"], { apiKey: "pa-key" })).rejects.toThrow(
      /Voyage embeddings request failed: 429/,
    );
    expect(calls).toBe(1);
  });
});
