import { describe, expect, it } from "vitest";
import { z } from "zod";

import { RerankScoresSchema } from "@opusfinder/llm";

import { toStrictJsonSchema } from "./strict-schema";

// The JSON schema the eval's caller sends. Pins that shapes go out as constraints and that a bound goes
// out both as its keyword (for a host that decodes against it) and in the description (for one that
// drops the keyword but shows the model the text).
describe("toStrictJsonSchema", () => {
  it("keeps object shapes, enums, constants and unions as constraints, and closes every object", () => {
    const schema = z.object({
      verdict: z.enum(["good", "borderline", "bad"]).describe("The verdict."),
      kind: z.literal("label"),
      note: z.string().nullable(),
      tags: z.array(z.object({ name: z.string() })),
      extra: z.string().optional(),
    });

    expect(toStrictJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        verdict: {
          type: "string",
          enum: ["good", "borderline", "bad"],
          description: "The verdict.",
        },
        kind: { type: "string", const: "label" },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
        tags: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
        },
        extra: { type: "string" },
      },
      required: ["verdict", "kind", "note", "tags"],
      additionalProperties: false,
    });
  });

  it("sends each bound as its keyword and in the description", () => {
    const schema = z.object({
      score: z.number().min(0).max(1).describe("Relevance."),
      reason: z.string().min(1).max(200),
      picks: z.array(z.string()).min(1).max(3),
    });

    expect(toStrictJsonSchema(schema).properties).toEqual({
      score: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Relevance.\n\n{minimum: 0, maximum: 1}",
      },
      reason: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "{minLength: 1, maxLength: 200}",
      },
      picks: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 3,
        description: "{minItems: 1, maxItems: 3}",
      },
    });
  });

  it("converts the rerank score schema", () => {
    expect(toStrictJsonSchema(RerankScoresSchema)).toEqual({
      type: "object",
      properties: {
        scores: {
          type: "array",
          description: "One entry per job in the provided candidate list.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "number",
                description: "The candidate job id, exactly as given in the list.",
              },
              score: {
                type: "number",
                minimum: 0,
                maximum: 1,
                description:
                  "Relevance from 0.0 to 1.0 (higher = better), per the system rubric.\n\n{minimum: 0, maximum: 1}",
              },
            },
            required: ["id", "score"],
            additionalProperties: false,
          },
        },
      },
      required: ["scores"],
      additionalProperties: false,
    });
  });
});
