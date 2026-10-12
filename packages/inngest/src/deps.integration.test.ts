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

describe("buildDigestDeps().rerank — real generateObject over MSW", () => {
  beforeAll(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.test/opusfinder");
  });
  afterAll(() => vi.unstubAllEnvs());

  it("leaves a chunk with an unusable reply unscored and keeps the chunks already scored", async () => {
    let calls = 0;
    server.use(
      http.post(MESSAGES_URL, () => {
        calls++;
        return HttpResponse.json(
          calls === 1
            ? anthropicMessage({ text: JSON.stringify({ scores: FIRST_CHUNK_SCORES }) })
            : anthropicMessage({ text: "I can't score these postings." }),
        );
      }),
    );

    const outcome = await buildDigestDeps().rerank(PROFILE, CANDIDATES);

    expect(calls).toBe(2);
    expect(outcome.scores.size).toBe(13);
    expect(outcome.scores.has(14)).toBe(false);
    expect(outcome.orderedIds).toHaveLength(14); // the unscored candidate is backfilled last
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
