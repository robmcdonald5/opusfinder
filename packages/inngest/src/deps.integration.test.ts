/**
 * Integration suite for the production rerank seam (`buildDigestDeps().rerank`): the shared rerank core
 * driving the REAL `generateObject` over MSW, so the chunk-failure policy is checked against the real
 * error classes rather than a stubbed call. Zero live egress (the integration setup fails unhandled
 * requests); the neon-http db is built but never queried.
 */
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { messagesReply, OPENROUTER_MESSAGES_URL } from "@test/msw/fixtures/openrouter";
import { server } from "@test/msw/server";

import { buildDigestDeps } from "./deps";

const PROFILE = { summary: "Backend engineer.", skills: ["Go"], targetRoles: ["Backend Engineer"] };
// 14 candidates → two chunks at the core's default chunk size of 13.
const CANDIDATES = Array.from({ length: 14 }, (_, i) => ({
  id: i + 1,
  title: `Job ${i + 1}`,
  descriptionText: "Build services.",
}));
const FIRST_CHUNK_SCORES = CANDIDATES.slice(0, 13).map((c) => ({ id: c.id, score: 0.8 }));

/** Answer the Nth Messages call with the Nth reply; returns a call counter. An off-schema reply is retried
 *  once by generateObject, so an unusable chunk takes two replies. */
function replyInOrder(...replies: object[]): () => number {
  let calls = 0;
  server.use(http.post(OPENROUTER_MESSAGES_URL, () => HttpResponse.json(replies[calls++])));
  return () => calls;
}

describe("buildDigestDeps().rerank — real generateObject over MSW", () => {
  beforeAll(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.test/opusfinder");
  });
  afterAll(() => vi.unstubAllEnvs());

  it("leaves a chunk with an unusable reply unscored and keeps the chunks already scored", async () => {
    const refusal = messagesReply({ text: "I can't score these postings." });
    const calls = replyInOrder(
      messagesReply({ text: JSON.stringify({ scores: FIRST_CHUNK_SCORES }) }),
      refusal,
      refusal,
    );

    const outcome = await buildDigestDeps().rerank(PROFILE, CANDIDATES);

    expect(calls()).toBe(3);
    expect(outcome.scores.size).toBe(13);
    expect(outcome.scores.has(14)).toBe(false);
    expect(outcome.orderedIds).toHaveLength(14); // the unscored candidate is backfilled last
  });

  it("leaves a chunk scored on the wrong scale unscored instead of clamping it to 1.0", async () => {
    const zeroToTen = messagesReply({
      text: JSON.stringify({
        scores: CANDIDATES.slice(0, 13).map((c, i) => ({ id: c.id, score: (i % 3) + 1 })),
      }),
    });
    replyInOrder(
      zeroToTen,
      zeroToTen,
      messagesReply({ text: JSON.stringify({ scores: [{ id: 14, score: 0.9 }] }) }),
    );

    const outcome = await buildDigestDeps().rerank(PROFILE, CANDIDATES);

    expect([...outcome.scores]).toEqual([[14, 0.9]]);
  });

  it("sums token, cost and prompt-cache counters across chunks", async () => {
    replyInOrder(
      messagesReply({
        text: JSON.stringify({ scores: FIRST_CHUNK_SCORES }),
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 4000,
          cache_read_input_tokens: 1000,
          cost: 0.002,
        },
      }),
      messagesReply({
        text: JSON.stringify({ scores: [{ id: 14, score: 0.6 }] }),
        usage: { input_tokens: 30, output_tokens: 5, cache_read_input_tokens: 4000, cost: 0.0005 },
      }),
    );

    const outcome = await buildDigestDeps().rerank(PROFILE, CANDIDATES);

    expect(outcome.usage).toEqual({ inputTokens: 130, outputTokens: 25, costUsd: 0.0025 });
    expect(outcome.cache).toEqual({ creationInputTokens: 4000, readInputTokens: 5000 });
  });

  it("still fails the rerank on a provider error", async () => {
    server.use(
      http.post(OPENROUTER_MESSAGES_URL, () =>
        HttpResponse.json(
          { type: "error", error: { type: "invalid_request_error", message: "bad request" } },
          { status: 400 },
        ),
      ),
    );

    await expect(buildDigestDeps().rerank(PROFILE, CANDIDATES)).rejects.toThrow();
  });
});
