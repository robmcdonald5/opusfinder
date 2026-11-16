import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@test/msw/server";
import { rejectionOf } from "@test/rejection";

import { challengerModel, NEMOTRON_PREFIX, QWEN_QUERY_TASK, qwenQueryText } from "./challengers";
import { asEmbedder, resolveSnapshotModel } from "./snapshot-models";

// The challengers' request contracts over MSW: the host pin and the per-side presentation are what a
// comparison depends on, and the refusals are what keep a wrong host or an unmetered answer out of a
// paid run. onUnhandledRequest:"error" proves zero live egress.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/embeddings";
const DEEPINFRA_URL = "https://api.deepinfra.com/v1/openai/embeddings";

/** An embeddings envelope of `count` 4096-wide vectors, with whatever else the host adds. */
function envelope(count: number, extra: Record<string, unknown> = {}) {
  return {
    data: Array.from({ length: count }, (_x, index) => ({
      index,
      embedding: Array.from({ length: 4096 }, (_y, d) => (d === index ? 1 : 0)),
    })),
    usage: { prompt_tokens: 7 * count, total_tokens: 7 * count },
    ...extra,
  };
}

describe("challenger models over MSW", () => {
  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("DEEPINFRA_API_KEY", "di-test");
  });
  afterEach(() => vi.unstubAllEnvs());

  describe("qwen3-embedding-8b (OpenRouter, pinned to DeepInfra)", () => {
    const qwen = challengerModel("qwen3-embedding-8b");

    it("sends the pinned request and reports tokens and the billed cost", async () => {
      let auth: string | null = null;
      let body: unknown;
      server.use(
        http.post(OPENROUTER_URL, async ({ request }) => {
          auth = request.headers.get("authorization");
          body = await request.json();
          return HttpResponse.json(
            envelope(2, { provider: "DeepInfra", usage: { total_tokens: 14, cost: 0.00000014 } }),
          );
        }),
      );

      const res = await qwen.embedBatch(["job one", "job two"], "document");

      expect(auth).toBe("Bearer sk-or-test");
      expect(body).toEqual({
        model: "qwen/qwen3-embedding-8b",
        provider: {
          only: ["deepinfra"],
          allow_fallbacks: false,
          data_collection: "deny",
          zdr: true,
        },
        // A document goes as it is.
        input: ["job one", "job two"],
        encoding_format: "float",
      });
      expect(res.embeddings).toHaveLength(2);
      expect(res.embeddings[1]?.[1]).toBe(1);
      expect(res.totalTokens).toBe(14);
      expect(res.costUsd).toBe(0.00000014);
    });

    it("wraps a query in the task instruction, on the query side only", async () => {
      let input: unknown;
      server.use(
        http.post(OPENROUTER_URL, async ({ request }) => {
          input = ((await request.json()) as { input: unknown }).input;
          return HttpResponse.json(envelope(1, { provider: "DeepInfra" }));
        }),
      );

      await qwen.embedBatch(["a nurse's resume"], "query");

      expect(input).toEqual([`Instruct: ${QWEN_QUERY_TASK}\nQuery:a nurse's resume`]);
      expect(qwenQueryText("x")).toBe(`Instruct: ${QWEN_QUERY_TASK}\nQuery:x`);
    });

    it("refuses an answer served by any other host", async () => {
      server.use(
        http.post(OPENROUTER_URL, () => HttpResponse.json(envelope(1, { provider: "Nebius" }))),
      );
      const err = await rejectionOf(qwen.embedBatch(["job"], "document"));
      expect(err.name).toBe("EmbeddingRejectedError");
      expect(err.message).toMatch(/expected DeepInfra to serve the request, got "Nebius"/);
    });

    it("refuses an answer that reports no token usage", async () => {
      server.use(
        http.post(OPENROUTER_URL, () =>
          HttpResponse.json(envelope(1, { provider: "DeepInfra", usage: {} })),
        ),
      );
      await expect(qwen.embedBatch(["job"], "document")).rejects.toThrow(/reported no token usage/);
    });

    it("marks a 404 (no allowed host) rejected and a 429 retryable, without the key in either", async () => {
      server.use(
        http.post(OPENROUTER_URL, () =>
          HttpResponse.json(
            { error: { message: "No allowed providers are available" } },
            { status: 404 },
          ),
        ),
      );
      const notFound = await rejectionOf(qwen.embedBatch(["job"], "document"));
      expect(notFound.name).toBe("EmbeddingRejectedError");
      expect(notFound.message).toMatch(/404.*No allowed providers/);

      server.use(
        http.post(OPENROUTER_URL, () => HttpResponse.json({ error: "slow down" }, { status: 429 })),
      );
      const limited = await rejectionOf(qwen.embedBatch(["job"], "document"));
      expect(limited.name).toBe("Error");
      expect(`${notFound.message} ${limited.message}`).not.toContain("sk-or-test");
    });
  });

  describe("nemotron-3-embed-8b (DeepInfra)", () => {
    const nemotron = challengerModel("nemotron-3-embed-8b");

    it("sends each side with its prefix, to DeepInfra, with DeepInfra's key", async () => {
      const bodies: unknown[] = [];
      let auth: string | null = null;
      server.use(
        http.post(DEEPINFRA_URL, async ({ request }) => {
          auth = request.headers.get("authorization");
          bodies.push(await request.json());
          return HttpResponse.json(envelope(1));
        }),
      );

      const doc = await nemotron.embedBatch(["a job"], "document");
      await nemotron.embedBatch(["a resume"], "query");

      expect(auth).toBe("Bearer di-test");
      expect(bodies).toEqual([
        {
          model: "nvidia/Nemotron-3-Embed-8B",
          input: ["passage: a job"],
          encoding_format: "float",
        },
        {
          model: "nvidia/Nemotron-3-Embed-8B",
          input: ["query: a resume"],
          encoding_format: "float",
        },
      ]);
      expect(NEMOTRON_PREFIX).toEqual({ document: "passage: ", query: "query: " });
      // DeepInfra reports no cost: spend is counted at the list price.
      expect(doc.costUsd).toBeUndefined();
      expect(doc.totalTokens).toBe(7);
    });

    it("refuses a vector of another width", async () => {
      server.use(
        http.post(DEEPINFRA_URL, () =>
          HttpResponse.json({
            data: [{ index: 0, embedding: [1, 0, 0] }],
            usage: { total_tokens: 3 },
          }),
        ),
      );
      await expect(nemotron.embedBatch(["a job"], "document")).rejects.toThrow(
        /3-dim vector.*expected 4096/,
      );
    });
  });

  it("as a plain Embedder: chunks to the model's limits, keeps order, and needs a side", async () => {
    const sizes: number[] = [];
    server.use(
      http.post(DEEPINFRA_URL, async ({ request }) => {
        const { input } = (await request.json()) as { input: string[] };
        sizes.push(input.length);
        return HttpResponse.json(envelope(input.length));
      }),
    );
    const embedder = asEmbedder(await resolveSnapshotModel("nemotron-3-embed-8b"));

    const vectors = await embedder(
      Array.from({ length: 40 }, (_x, i) => `job ${i}`),
      "document",
    );

    expect(sizes).toEqual([32, 8]);
    expect(vectors).toHaveLength(40);
    await expect(embedder(["x"], null)).rejects.toThrow(/needs "query" or "document"/);
  });
});
