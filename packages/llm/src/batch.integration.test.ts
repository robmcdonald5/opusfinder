import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  batchErrored,
  batchObject,
  batchSucceeded,
  OPENROUTER_BATCHES_URL,
} from "@test/msw/fixtures/openrouter";
import { server } from "@test/msw/server";
import { rejectionOf } from "@test/rejection";

import { batchGenerate, collectBatchResults, pollBatch, submitBatch } from "./batch";
import type { BatchRequest } from "./batch";
import { parseObject } from "./generate-object";

// The OpenRouter Batch API lifecycle over MSW. Asserts the submit contract (endpoint + model BEFORE the
// requests, each body the shared Messages body), the poll mapping, the inline results mapping (only the
// SECRET-free error type escapes), the throw on a batch that ended without results, request-order
// re-assembly, and the timeout throw. Zero live egress.

type SubmitBody = {
  endpoint?: string;
  model?: string;
  requests?: { custom_id: string; body: Record<string, unknown> }[];
};

function req(overrides: Partial<BatchRequest> = {}): BatchRequest {
  return {
    customId: "r1",
    model: "haiku",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

describe("batch — OpenRouter Batch API over MSW", () => {
  beforeAll(() => vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test"));
  afterAll(() => vi.unstubAllEnvs());

  it("submits endpoint and model before the requests, each body the Messages body without routing fields", async () => {
    let raw = "";
    server.use(
      http.post(OPENROUTER_BATCHES_URL, async ({ request }) => {
        raw = await request.text();
        return HttpResponse.json(batchObject({ id: "batch_abc" }), { status: 202 });
      }),
    );

    const id = await submitBatch([
      req({
        customId: "a",
        system: "you are terse",
        cacheSystem: true,
        effort: "low",
        thinking: "off",
        schema: z.object({ city: z.string() }),
      }),
    ]);

    expect(id).toBe("batch_abc");
    // The API stream-parses the body and 400s when `requests` comes first.
    expect(raw.indexOf('"endpoint"')).toBeLessThan(raw.indexOf('"requests"'));
    expect(raw.indexOf('"model"')).toBeLessThan(raw.indexOf('"requests"'));
    const body = JSON.parse(raw) as SubmitBody;
    expect(body.endpoint).toBe("/v1/messages");
    expect(body.model).toBe("anthropic/claude-haiku-5.5");
    const request = body.requests?.[0];
    expect(request?.custom_id).toBe("a");
    expect(request?.body).toMatchObject({
      max_tokens: 1024,
      system: [
        { type: "text", text: "you are terse", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    expect(request?.body).not.toHaveProperty("model"); // inherits the batch's
    expect(request?.body).not.toHaveProperty("provider"); // the Batch API takes routing only at the top level
  });

  it("maps a poll to ended/in-progress plus the state and counts", async () => {
    server.use(
      http.get(`${OPENROUTER_BATCHES_URL}/:id`, ({ params }) =>
        HttpResponse.json(
          batchObject({
            id: String(params.id),
            status: params.id === "done" ? "failed" : "finalizing",
            counts: { total: 3, completed: 2, failed: 1 },
          }),
        ),
      ),
    );

    expect(await pollBatch("busy")).toEqual({
      status: "in_progress",
      state: "finalizing",
      counts: { total: 3, completed: 2, failed: 1 },
    });
    expect((await pollBatch("done")).status).toBe("ended"); // failed is terminal too
  });

  it("collects inline results by customId with the batch cost; an errored result keeps only its type", async () => {
    server.use(
      http.get(`${OPENROUTER_BATCHES_URL}/:id`, ({ params }) =>
        HttpResponse.json(
          batchObject({
            id: String(params.id),
            status: "completed",
            cost: 0.0042,
            results: [
              batchSucceeded("ok1", {
                text: '{"city": "Rome"}',
                usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 7 },
              }),
              batchErrored("bad1", "invalid_request"),
            ],
          }),
        ),
      ),
    );

    const { results, costUsd } = await collectBatchResults("batch_x");

    expect(costUsd).toBe(0.0042);
    expect(results.get("ok1")).toEqual({
      customId: "ok1",
      status: "succeeded",
      text: '{"city": "Rome"}',
      stopReason: "end_turn",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 7,
      },
    });
    expect(parseObject(z.object({ city: z.string() }), results.get("ok1")?.text ?? "")).toEqual({
      city: "Rome",
    });
    const bad = results.get("bad1");
    expect(bad).toMatchObject({ status: "errored", text: "", error: "invalid_request" });
    expect(JSON.stringify(bad)).not.toContain("secret detail");
  });

  it("throws, with the batch's reason, when it ended without results", async () => {
    server.use(
      http.get(`${OPENROUTER_BATCHES_URL}/:id`, ({ params }) =>
        HttpResponse.json(
          batchObject({
            id: String(params.id),
            status: "failed",
            error: "uses an unsupported setting",
          }),
        ),
      ),
    );

    const err = await rejectionOf(collectBatchResults("batch_f"));

    expect(err.message).toBe(
      "collectBatchResults: batch batch_f is failed, not completed: uses an unsupported setting",
    );
  });

  it("batchGenerate submits, polls until ended, and returns results in REQUEST order", async () => {
    let polls = 0;
    server.use(
      http.post(OPENROUTER_BATCHES_URL, () =>
        HttpResponse.json(batchObject({ id: "batch_g" }), { status: 202 }),
      ),
      http.get(`${OPENROUTER_BATCHES_URL}/:id`, ({ params }) => {
        polls += 1;
        // Deliberately out of request order: r2 before r1.
        return HttpResponse.json(
          polls >= 2
            ? batchObject({
                id: String(params.id),
                status: "completed",
                results: [
                  batchSucceeded("r2", { text: "second" }),
                  batchSucceeded("r1", { text: "first" }),
                ],
              })
            : batchObject({ id: String(params.id), status: "in_progress" }),
        );
      }),
    );

    const { results } = await batchGenerate([req({ customId: "r1" }), req({ customId: "r2" })], {
      pollIntervalMs: 1,
    });

    expect(polls).toBeGreaterThanOrEqual(3); // in_progress, completed, then the collect read
    expect(results.map((r) => r.customId)).toEqual(["r1", "r2"]);
    expect(results.map((r) => r.text)).toEqual(["first", "second"]);
  });

  it("batchGenerate yields a placeholder for a request absent from the results", async () => {
    server.use(
      http.post(OPENROUTER_BATCHES_URL, () =>
        HttpResponse.json(batchObject({ id: "batch_m" }), { status: 202 }),
      ),
      http.get(`${OPENROUTER_BATCHES_URL}/:id`, ({ params }) =>
        HttpResponse.json(
          batchObject({
            id: String(params.id),
            status: "completed",
            results: [batchSucceeded("present")],
          }),
        ),
      ),
    );

    const { results } = await batchGenerate(
      [req({ customId: "present" }), req({ customId: "absent" })],
      {
        pollIntervalMs: 1,
      },
    );

    expect(results[1]).toEqual({
      customId: "absent",
      status: "errored",
      text: "",
      error: "missing from batch results",
    });
  });

  it("throws when the batch does not end within maxWaitMs", async () => {
    server.use(
      http.post(OPENROUTER_BATCHES_URL, () =>
        HttpResponse.json(batchObject({ id: "batch_t" }), { status: 202 }),
      ),
      http.get(`${OPENROUTER_BATCHES_URL}/:id`, ({ params }) =>
        HttpResponse.json(batchObject({ id: String(params.id), status: "in_progress" })),
      ),
    );

    await expect(batchGenerate([req()], { pollIntervalMs: 1, maxWaitMs: 0 })).rejects.toThrow(
      /batchGenerate: batch batch_t did not end within 0ms \(state in_progress\)/,
    );
  });
});
