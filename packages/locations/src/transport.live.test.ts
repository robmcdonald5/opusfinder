/**
 * LIVE gate (opt-in) for the location model against the real provider: one structured call and one small
 * batch (submit, then wait and collect), both with the production request (cached system block, structured
 * output, low effort, thinking off). Costs well under a cent; the batch can take 10+ minutes.
 *
 *   LOCATIONS_LIVE_TEST=1 pnpm test:live --project live packages/locations
 */
import { describe, expect, it } from "vitest";

import { buildLocationRequest } from "./model";
import { parseAnswer } from "./resolve";
import { createLocationModel } from "./transport";

const GATED = process.env.LOCATIONS_LIVE_TEST !== "1" || !process.env.OPENROUTER_API_KEY;

const OHIO_CO = {
  slug: "buckeye",
  source: "greenhouse",
  otherStrings: ["Columbus, OH", "Cincinnati, OH"],
};

describe.skipIf(GATED)("location model (live: Claude Haiku through OpenRouter)", () => {
  const model = createLocationModel();

  it("answers a structured call that validates against the schema", async () => {
    const answer = await model.generate(
      buildLocationRequest("p0", { raw: "Columbus, OH", company: OHIO_CO }),
    );
    const parsed = parseAnswer(answer);
    if (!("value" in parsed)) throw new Error(`no usable answer: ${JSON.stringify(parsed)}`);
    expect(parsed.value.places).toEqual([
      { city: "Columbus", region: "Ohio", country: "US", kind: "city" },
    ]);
  }, 120_000);

  it(
    "answers a three-request batch with structured outputs",
    async () => {
      const requests = [
        buildLocationRequest("b0", { raw: "Remote - USA" }),
        buildLocationRequest("b1", { raw: "Remote - EMEA" }),
        buildLocationRequest("b2", { raw: "San Francisco, CA | New York City, NY" }),
      ];
      const answers = await model.collectBatch(await model.submitBatch(requests));
      const values = requests.map((r) => {
        const parsed = parseAnswer(answers.get(r.id) ?? { status: "failed", reason: "missing" });
        if (!("value" in parsed)) throw new Error(`${r.id}: ${JSON.stringify(parsed)}`);
        return parsed.value;
      });
      expect(values[0]!.remoteCountries).toEqual(["US"]);
      expect(values[1]!.areas).toEqual(["EMEA"]);
      expect(values[2]!.places.map((p) => p.city)).toEqual(["San Francisco", "New York City"]);
    },
    45 * 60_000,
  );
});
