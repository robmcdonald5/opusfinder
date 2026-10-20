import { describe, expect, it } from "vitest";

import { buildLocationRequest } from "./model";
import { LOCATION_SYSTEM, PROMPT_STRINGS, renderPair } from "./prompt";
import { LocationAnswerSchema } from "./schema";

describe("location request", () => {
  it("sends the same system block and schema for every pair, at low effort with thinking off", () => {
    const a = buildLocationRequest("p0", { raw: "Columbus, OH" });
    const b = buildLocationRequest("p1", {
      raw: "Dublin",
      company: { slug: "stripe", source: "greenhouse", otherStrings: ["Dublin, Ireland"] },
    });
    expect(a.system).toBe(b.system);
    expect(a.schema).toBe(LocationAnswerSchema);
    expect(a).toMatchObject({ id: "p0", effort: "low", thinking: "off", maxOutputTokens: 4096 });
    expect(b.user).not.toBe(a.user);
  });

  it("puts the company and its other strings in the user message, JSON-quoted", () => {
    expect(
      renderPair({
        raw: 'Dublin "HQ"',
        company: {
          slug: "stripe",
          source: "greenhouse",
          otherStrings: ["Dublin, Ireland", "London"],
        },
      }),
    ).toBe(
      [
        "Company: stripe (greenhouse job board)",
        "The company's other location strings:",
        '- "Dublin, Ireland"',
        '- "London"',
        'Location text: "Dublin \\"HQ\\""',
      ].join("\n"),
    );
    expect(renderPair({ raw: "EMEA" })).toBe('Location text: "EMEA"');
  });

  it("keeps the cacheable system block past the provider's 512-token cache minimum", () => {
    // ~4 characters per token, so 4,000 characters is comfortably over 512 tokens.
    expect(LOCATION_SYSTEM.length).toBeGreaterThan(4000);
  });

  it("writes every worked example's answer in the schema the model must follow", () => {
    const answers = [...LOCATION_SYSTEM.matchAll(/Answer:\n(.+)\n<\/example>/g)].map((m) =>
      JSON.parse(m[1]!),
    );
    expect(answers.length).toBeGreaterThan(15);
    for (const answer of answers) expect(LocationAnswerSchema.safeParse(answer).success).toBe(true);
  });

  it("knows which strings the prompt quotes, so the golden set can be scored without them", () => {
    expect(PROMPT_STRINGS.has("US-WA-Bellevue")).toBe(true); // an example input
    expect(PROMPT_STRINGS.has("US-CA-Menlo Park")).toBe(true); // quoted in a rule
    expect(PROMPT_STRINGS.has("Columbus, OH")).toBe(true);
  });
});
