import { describe, expect, it } from "vitest";
import { z } from "zod";

import { RerankScoresSchema } from "@opusfinder/llm";

import { toStrictJsonSchema } from "./strict-schema";

// The JSON schema the eval's caller sends. Pins which constraints go out as constraints (so a host's
// decoding enforces them) and which are only described (so no host rejects the request over them).
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

  it("moves the bounds a strict mode may reject into the description", () => {
    const schema = z.object({
      score: z.number().min(0).max(1).describe("Relevance."),
      reason: z.string().min(1).max(200),
      picks: z.array(z.string()).min(1).max(3),
    });

    expect(toStrictJsonSchema(schema).properties).toEqual({
      score: { type: "number", description: "Relevance.\n\n{minimum: 0, maximum: 1}" },
      reason: { type: "string", description: "{minLength: 1, maxLength: 200}" },
      picks: {
        type: "array",
        items: { type: "string" },
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
