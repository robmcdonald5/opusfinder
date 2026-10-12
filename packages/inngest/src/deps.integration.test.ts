/**
 * Integration suite for the production rerank seam (`buildDigestDeps().rerank`): the shared rerank core
 * driving the REAL `generateObject` over MSW, so the chunk-failure policy is checked against the real
 * error classes rather than a stubbed call. Zero live egress (the integration setup fails unhandled
 * requests); the neon-http db is built but never queried.
 */
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { anthropicMessage } from "@test/msw/fixtures/anthropic";
import { server } from "@test/msw/server";

import { buildDigestDeps } from "./deps";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const PROFILE = { summary: "Backend engineer.", skills: ["Go"], targetRoles: ["Backend Engineer"] };
// 14 candidates → two chunks at the core's default chunk size of 13.
const CANDIDATES = Array.from({ length: 14 }, (_, i) => ({
  id: i + 1,
  title: `Job ${i + 1}`,
  descriptionText: "Build services.",
}));
const FIRST_CHUNK_SCORES = CANDIDATES.slice(0, 13).map((c) => ({ id: c.id, score: 0.8 }));

/** Answer the Nth Messages call with the Nth reply; returns a call counter. */
function replyInOrder(...replies: object[]): () => number {
  let calls = 0;
  server.use(http.post(MESSAGES_URL, () => HttpResponse.json(replies[calls++])));
  return () => calls;
}

describe("buildDigestDeps().rerank — real generateObject over MSW", () => {
  beforeAll(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.test/opusfinder");
  });
  afterAll(() => vi.unstubAllEnvs());

  it("leaves a chunk with an unusable reply unscored and keeps the chunks already scored", async () => {
    const calls = replyInOrder(
      anthropicMessage({ text: JSON.stringify({ scores: FIRST_CHUNK_SCORES }) }),
      anthropicMessage({ text: "I can't score these postings." }),
    );

    const outcome = await buildDigestDeps().rerank(PROFILE, CANDIDATES);

    expect(calls()).toBe(2);
    expect(outcome.scores.size).toBe(13);
    expect(outcome.scores.has(14)).toBe(false);
    expect(outcome.orderedIds).toHaveLength(14); // the unscored candidate is backfilled last
  });

  it("leaves a chunk scored on the wrong scale unscored instead of clamping it to 1.0", async () => {
    const zeroToTen = CANDIDATES.slice(0, 13).map((c, i) => ({ id: c.id, score: (i % 3) + 1 }));
    replyInOrder(
      anthropicMessage({ text: JSON.stringify({ scores: zeroToTen }) }),
      anthropicMessage({ text: JSON.stringify({ scores: [{ id: 14, score: 0.9 }] }) }),
    );

    const outcome = await buildDigestDeps().rerank(PROFILE, CANDIDATES);

    expect([...outcome.scores]).toEqual([[14, 0.9]]);
  });

  it("sums token and prompt-cache counters across chunks", async () => {
    replyInOrder(
      anthropicMessage({
        text: JSON.stringify({ scores: FIRST_CHUNK_SCORES }),
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 4000,
          cache_read_input_tokens: 1000,
        },
      }),
      anthropicMessage({
        text: JSON.stringify({ scores: [{ id: 14, score: 0.6 }] }),
        usage: { input_tokens: 30, output_tokens: 5, cache_read_input_tokens: 4000 },
      }),
    );

    const outcome = await buildDigestDeps().rerank(PROFILE, CANDIDATES);

    expect(outcome.usage).toEqual({ inputTokens: 130, outputTokens: 25 });
    expect(outcome.cache).toEqual({ creationInputTokens: 4000, readInputTokens: 5000 });
  });

  it("still fails the rerank on a provider error", async () => {
    server.use(
      http.post(MESSAGES_URL, () =>
        HttpResponse.json(
          { type: "error", error: { type: "invalid_request_error", message: "bad request" } },
          { status: 400 },
        ),
      ),
    );

    await expect(buildDigestDeps().rerank(PROFILE, CANDIDATES)).rejects.toThrow();
  });
});
