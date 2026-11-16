/**
 * LIVE gate (opt-in): real requests through the eval's model caller. The unit suite pins the request and
 * the checks against a stubbed fetch; this proves what a stub can't: that OpenRouter accepts the pinned,
 * strict-schema request for an Anthropic and a non-Anthropic model, that the reply really names the host
 * that served it by the name the provider list gives the pinned slug, and that a pin the model isn't
 * served on fails rather than running somewhere else.
 *
 * Gated on MODEL_CALLER_LIVE_TEST=1 on top of the key (packages/llm/.env, loaded by the caller's import).
 * Costs well under a cent.
 *
 *   MODEL_CALLER_LIVE_TEST=1 pnpm test:live
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { OpenRouterError } from "@opusfinder/llm/node";
import { rejectionOf } from "@test/rejection";

import { callModel, type ModelRoute } from "./model-caller";

const LIVE = process.env.MODEL_CALLER_LIVE_TEST === "1" && !!process.env.OPENROUTER_API_KEY;

const Fit = z.object({
  fit: z.enum(["good", "bad"]).describe("Whether the job suits the candidate."),
  score: z.number().min(0).max(1).describe("Relevance from 0.0 to 1.0."),
});
const ask = (route: ModelRoute) =>
  callModel({
    route,
    schema: Fit,
    schemaName: "fit",
    // The scale is stated here, not left to the schema: not every host shows the model the schema's text.
    system:
      "You judge whether a job suits a candidate. Answer with a JSON object: `fit` is good or bad, " +
      "`score` is the relevance from 0.0 to 1.0.",
    messages: [
      {
        role: "user",
        content:
          "Candidate: senior backend engineer, Go and PostgreSQL. Job: Senior Backend Engineer, Go services on Postgres.",
      },
    ],
    reasoningEffort: "low",
    maxOutputTokens: 1024,
  });

describe.skipIf(!LIVE)("callModel (live: real OpenRouter)", () => {
  it("gets a valid object from a non-Anthropic model on its pinned host", async () => {
    const result = await ask({
      model: "deepseek/deepseek-v4.1-flash",
      hosts: ["deepinfra/fp8"],
      quantizations: ["fp8"],
    });

    expect(result.object.fit).toBe("good");
    expect(result.host).toBe("DeepInfra");
    expect(result.servedModel).toMatch(/^deepseek\/deepseek-v4\.1-flash-\d{8}$/);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.costUsd).toBeGreaterThan(0);
  });

  it("gets a valid object from Haiku pinned to Anthropic", async () => {
    const result = await ask({ model: "anthropic/claude-haiku-5.5", hosts: ["anthropic"] });

    expect(result.object.fit).toBe("good");
    expect(result.host).toBe("Anthropic");
    expect(result.servedModel).toMatch(/^anthropic\/claude-haiku-5\.5-\d{8}$/);
  });

  it("fails rather than run on another host when the pinned one doesn't serve the model", async () => {
    const err = await rejectionOf(
      ask({ model: "anthropic/claude-haiku-5.5", hosts: ["deepinfra"] }),
    );

    expect(err).toBeInstanceOf(OpenRouterError);
    expect((err as OpenRouterError).status).toBe(404);
  });
});
