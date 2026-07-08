import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { batchObject, batchResultLine, jsonl } from "@test/msw/fixtures/anthropic";
import { server } from "@test/msw/server";

import { batchGenerate, collectBatchResults, pollBatch, submitBatch } from "./batch";
import type { BatchRequest } from "./batch";

// The ONE place that talks to the raw @anthropic-ai/sdk (the AI SDK has no batch support), intercepted by
// MSW. Asserts the create request shape (custom_id + params: model/max_tokens/messages/system-cache/temp),
// the poll mapping, and the two-hop results path — results() retrieves the batch, reads `results_url`, then
// GETs a JSONL stream the SDK's JSONLDecoder parses line-by-line. Covers succeeded/errored/expired/canceled
// mapping (errored surfaces only the SECRET-free type), request-order re-assembly, the missing-result
// placeholder, and the timeout -> best-effort cancel -> throw path. Zero live egress.

const BATCHES = "https://api.anthropic.com/v1/messages/batches";

type CreateReq = { custom_id: string; params: Record<string, unknown> };
type CreateBody = { requests: CreateReq[] };

function req(overrides: Partial<BatchRequest> = {}): BatchRequest {
  return { customId: "r1", model: "haiku", messages: [{ role: "user", content: "hi" }], ...overrides };
}

describe("batch — Anthropic Message Batches over MSW", () => {
  beforeAll(() => vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test"));
  afterAll(() => vi.unstubAllEnvs());

  it("submits the raw create contract (model/max_tokens defaults, string message) and returns the id", async () => {
    let body: CreateBody | undefined;
    server.use(
      http.post(BATCHES, async ({ request }) => {
        body = (await request.json()) as CreateBody;
        return HttpResponse.json(batchObject({ id: "batch_abc" }));
      }),
    );

    const id = await submitBatch([req({ customId: "a", messages: [{ role: "user", content: "plain string" }] })]);

    expect(id).toBe("batch_abc");
    const params = body?.requests?.[0]?.params;
    expect(body?.requests?.[0]?.custom_id).toBe("a");
    expect(params?.model).toBe("claude-haiku-4-5"); // modelId('haiku'), not the alias
    expect(params?.max_tokens).toBe(1024); // DEFAULT_MAX_OUTPUT_TOKENS
    expect(params?.messages).toEqual([{ role: "user", content: "plain string" }]);
    expect(params).not.toHaveProperty("system"); // omitted when unset, not sent as undefined
    expect(params).not.toHaveProperty("temperature");
  });

  it("promotes a cached system prompt to a 1h-TTL text block and forwards overrides + a text-part message", async () => {
    let body: CreateBody | undefined;
    server.use(
      http.post(BATCHES, async ({ request }) => {
        body = (await request.json()) as CreateBody;
        return HttpResponse.json(batchObject({ id: "batch_c" }));
      }),
    );

    await submitBatch([
      req({
        customId: "c",
        system: "you are terse",
        cacheSystem: true,
        maxOutputTokens: 4096,
        temperature: 0.3,
        messages: [{ role: "user", content: [{ type: "text", text: "text block" }] }],
      }),
    ]);

    const params = body?.requests?.[0]?.params;
    expect(params?.max_tokens).toBe(4096);
    expect(params?.temperature).toBe(0.3);
    expect(params?.messages).toEqual([{ role: "user", content: [{ type: "text", text: "text block" }] }]);
    expect(params?.system).toEqual([
      { type: "text", text: "you are terse", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
  });

  it("passes an uncached system prompt through as a plain string", async () => {
    let body: CreateBody | undefined;
    server.use(
      http.post(BATCHES, async ({ request }) => {
        body = (await request.json()) as CreateBody;
        return HttpResponse.json(batchObject({ id: "batch_s" }));
      }),
    );

    await submitBatch([req({ customId: "s", system: "plain sys" })]); // no cacheSystem

    expect(body?.requests?.[0]?.params?.system).toBe("plain sys");
  });

  it("rejects a malformed batch before any network call", async () => {
    let posts = 0;
    server.use(
      http.post(BATCHES, () => {
        posts += 1;
        return HttpResponse.json(batchObject());
      }),
    );

    await expect(submitBatch([])).rejects.toThrow("submitBatch: received no requests.");
    await expect(submitBatch([req({ customId: "bad id!" })])).rejects.toThrow(/must match/);
    await expect(submitBatch([req({ customId: "dup" }), req({ customId: "dup" })])).rejects.toThrow(/duplicate/);
    await expect(
      submitBatch([req({ messages: [{ role: "system", content: "x" }] })]),
    ).rejects.toThrow(/unsupported message role/);
    expect(posts).toBe(0); // every failure is caught pre-network
  });

  it("maps a poll to status + per-status counts", async () => {
    server.use(
      http.get(`${BATCHES}/:id`, () =>
        HttpResponse.json(
          batchObject({ status: "in_progress", counts: { processing: 3, succeeded: 2, errored: 1 } }),
        ),
      ),
    );

    const poll = await pollBatch("batch_x");

    expect(poll).toEqual({
      status: "in_progress",
      counts: { processing: 3, succeeded: 2, errored: 1, canceled: 0, expired: 0 },
    });
  });

  it("collects results by customId across the retrieve->results JSONL two-hop (all four result types)", async () => {
    server.use(
      http.get(`${BATCHES}/:id`, ({ params }) =>
        HttpResponse.json(batchObject({ id: String(params.id), status: "ended" })),
      ),
      http.get(`${BATCHES}/:id/results`, () =>
        HttpResponse.text(
          jsonl([
            batchResultLine("ok1", {
              type: "succeeded",
              text: "the answer",
              usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 7 },
            }),
            batchResultLine("bad1", { type: "errored", errorType: "invalid_request_error" }),
            batchResultLine("exp1", { type: "expired" }),
            batchResultLine("can1", { type: "canceled" }),
          ]),
        ),
      ),
    );

    const map = await collectBatchResults("batch_x");

    expect(map.get("ok1")).toEqual({
      customId: "ok1",
      status: "succeeded",
      text: "the answer",
      // absent cache_creation_input_tokens -> 0; cache_read_input_tokens camelCased through
      usage: { inputTokens: 10, outputTokens: 4, cacheCreationInputTokens: 0, cacheReadInputTokens: 7 },
    });
    const bad = map.get("bad1");
    expect(bad).toMatchObject({ status: "errored", text: "", error: "invalid_request_error" });
    expect(JSON.stringify(bad)).not.toContain("secret detail"); // only the type escapes, never the message
    expect(map.get("exp1")).toMatchObject({ status: "expired", error: "expired" });
    expect(map.get("can1")).toMatchObject({ status: "canceled", error: "canceled" });
  });

  it("throws the SDK's no-results_url guard when the batch has not finished", async () => {
    server.use(
      http.get(`${BATCHES}/:id`, ({ params }) =>
        HttpResponse.json(batchObject({ id: String(params.id), status: "in_progress" })), // results_url: null
      ),
    );

    await expect(collectBatchResults("batch_x")).rejects.toThrow("No batch `results_url`");
  });

  it("batchGenerate submits, polls until ended, and returns results in REQUEST order", async () => {
    let polls = 0;
    server.use(
      http.post(BATCHES, () => HttpResponse.json(batchObject({ id: "batch_g" }))),
      http.get(`${BATCHES}/:id`, ({ params }) => {
        polls += 1;
        const status = polls >= 2 ? "ended" : "in_progress"; // first poll in-progress, then ended
        return HttpResponse.json(batchObject({ id: String(params.id), status, counts: { succeeded: 2 } }));
      }),
      http.get(`${BATCHES}/:id/results`, () =>
        HttpResponse.text(
          // deliberately out of request order: r2 before r1
          jsonl([
            batchResultLine("r2", { type: "succeeded", text: "second" }),
            batchResultLine("r1", { type: "succeeded", text: "first" }),
          ]),
        ),
      ),
    );

    const results = await batchGenerate([req({ customId: "r1" }), req({ customId: "r2" })], {
      pollIntervalMs: 1,
    });

    expect(polls).toBeGreaterThanOrEqual(2); // observed the in_progress -> ended transition
    expect(results.map((r) => r.customId)).toEqual(["r1", "r2"]); // request order, not results order
    expect(results.map((r) => r.text)).toEqual(["first", "second"]);
  });

  it("batchGenerate yields a placeholder for a request absent from the results", async () => {
    server.use(
      http.post(BATCHES, () => HttpResponse.json(batchObject({ id: "batch_m" }))),
      http.get(`${BATCHES}/:id`, ({ params }) =>
        HttpResponse.json(batchObject({ id: String(params.id), status: "ended" })),
      ),
      http.get(`${BATCHES}/:id/results`, () =>
        HttpResponse.text(jsonl([batchResultLine("present", { type: "succeeded", text: "ok" })])),
      ),
    );

    const results = await batchGenerate([req({ customId: "present" }), req({ customId: "absent" })], {
      pollIntervalMs: 1,
    });

    expect(results[1]).toEqual({
      customId: "absent",
      status: "errored",
      text: "",
      error: "missing from batch results",
    });
  });

  it("cancels (best-effort) and throws when the batch does not end within maxWaitMs; a cancel failure is swallowed", async () => {
    let cancelHits = 0;
    server.use(
      http.post(BATCHES, () => HttpResponse.json(batchObject({ id: "batch_t" }))),
      http.get(`${BATCHES}/:id`, ({ params }) =>
        HttpResponse.json(batchObject({ id: String(params.id), status: "in_progress", counts: { processing: 1 } })),
      ),
      http.post(`${BATCHES}/:id/cancel`, () => {
        cancelHits += 1;
        // 400 (not a retryable status) so the count is deterministic; the wrapper must swallow it.
        return HttpResponse.json({ type: "error", error: { type: "invalid_request_error" } }, { status: 400 });
      }),
    );

    await expect(
      batchGenerate([req({ customId: "r1" })], { pollIntervalMs: 1, maxWaitMs: 0 }),
    ).rejects.toThrow(/batchGenerate: batch batch_t did not end within 0ms/);
    expect(cancelHits).toBe(1); // the best-effort cancel was attempted, its failure did not mask the timeout
  });
});
