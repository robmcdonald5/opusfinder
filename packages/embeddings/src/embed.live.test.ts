/**
 * LIVE gate (opt-in) — a real embedding request against the Voyage API. The MSW integration suite
 * (embed.integration.test.ts) proves the request shape, chunking, and usage reassembly against a mocked
 * boundary; this gate proves the things a mock CANNOT: that a real `voyage-4-large` call returns vectors
 * of the expected width, reports token usage, and — critically for retrieval — that the `inputType`
 * asymmetry (query vs document) actually reaches Voyage and produces DIFFERENT vectors for the same text
 * (the asymmetry that improves retrieval; a mock could not distinguish a real one from a no-op).
 *
 * LIVES IN THE `live` VITEST PROJECT (`*.live.test.ts`, no MSW) — NOT `integration`. MSW 2.x intercepts
 * `fetch`, so a real Voyage POST would hard-fail under the integration project's onUnhandledRequest:"error".
 *
 * NEVER runs in CI's secret-free lane: gated on an EXPLICIT opt-in flag (VOYAGE_LIVE_TEST=1) ON TOP of the
 * key. Cost is ~$0 (a few hundred tokens against the 200M free-token allotment, §9 Q6). Importing `./embed`
 * transitively pulls `./provider` → `./env`, whose loadPackageEnv populates VOYAGE_API_KEY from
 * packages/embeddings/.env before this gate evaluates; the getters are lazy so the file loads — and skips —
 * without a key.
 *
 *   VOYAGE_LIVE_TEST=1 pnpm test:live
 */
import { describe, expect, it } from "vitest";

import { embed } from "./embed";
import { EMBED_DIMENSIONS, EMBED_MODEL } from "./provider";

const LIVE = process.env.VOYAGE_LIVE_TEST === "1" && !!process.env.VOYAGE_API_KEY;

describe.skipIf(!LIVE)("Voyage embeddings (live: real API)", () => {
  it("returns one voyage-4-large vector of the expected width per input, with token usage", async () => {
    const texts = [
      "Senior backend engineer, Go and Postgres, distributed systems.",
      "Frontend developer, React and TypeScript, design systems.",
      "Data scientist, Python, recommendation models.",
    ];
    const res = await embed(texts, { inputType: "document" });

    expect(res.model).toBe(EMBED_MODEL);
    expect(res.embeddings).toHaveLength(texts.length);
    for (const vec of res.embeddings) {
      expect(vec).toHaveLength(EMBED_DIMENSIONS);
      // Every component is a real finite number over the wire (not null/NaN from a parse mishap).
      expect(vec.every((x) => Number.isFinite(x))).toBe(true);
    }
    // A real request reports non-zero token usage; the mocked suite can only assert the reassembly math.
    expect(res.usage.totalTokens).toBeGreaterThan(0);
  });

  it("threads inputType to Voyage — the same text embeds differently as query vs document", async () => {
    const text = "Staff platform engineer, Kubernetes and observability.";
    const [asQuery] = (await embed([text], { inputType: "query" })).embeddings;
    const [asDocument] = (await embed([text], { inputType: "document" })).embeddings;

    expect(asQuery).toHaveLength(EMBED_DIMENSIONS);
    expect(asDocument).toHaveLength(EMBED_DIMENSIONS);
    // The query/document asymmetry is the retrieval-critical behavior. Voyage prepends a per-inputType
    // prompt, so a REAL asymmetry shifts essentially EVERY component — assert a majority differ, not a
    // bare `not.toEqual`. If inputType were dropped on the wire the two requests would be byte-identical
    // and match exactly (or differ only in a few low-order bits from server nondeterminism); either way
    // far fewer than half the components move, so this reddens on the regression without flaking on noise.
    const differing = asQuery!.filter((x, i) => x !== asDocument![i]).length;
    expect(differing).toBeGreaterThan(EMBED_DIMENSIONS / 2);
  });
});
