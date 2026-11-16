import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startSharedPackagesWorker, type SharedPackagesWorker } from "@test/worker/harness";

import { PROMPT_VERSION } from "./prompt";

// @opusfinder/llm, embeddings, locations and email running INSIDE workerd, with their keys passed in from
// bindings: the bundle `pnpm guard:worker` checks (test/worker/shared-packages.ts), executed. The guard
// proves no node:* builtin is imported; only running the code proves no Node global (Buffer, process) is
// touched, and that Web Crypto gives the digests node:crypto gave. It lives in this package because
// locations sits on top of the others' graph; the entry reaches all four by path.

const KEYS = {
  OPENROUTER_API_KEY: "sk-or-worker",
  VOYAGE_API_KEY: "pa-worker",
  RESEND_API_KEY: "re_worker",
  EMAIL_FROM: "opusfinder <alerts@send.test>",
  ALERT_TO: "ops@example.test",
};
const LOCATION_ANSWER = {
  reason: "r",
  places: [],
  remoteCountries: ["US"],
  areas: [],
  confidence: "high",
};

interface Seen {
  url: string;
  auth: string | null;
  body: Record<string, unknown>;
}

describe("the shared packages in workerd", () => {
  let worker: SharedPackagesWorker;
  const seen: Seen[] = [];
  const last = (): Seen => seen[seen.length - 1]!;

  beforeAll(async () => {
    worker = await startSharedPackagesWorker(KEYS, async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      seen.push({ url: request.url, auth: request.headers.get("authorization"), body });
      if (request.url === "https://openrouter.ai/api/v1/messages") {
        const structured = "output_config" in body;
        return Response.json({
          content: [{ type: "text", text: structured ? JSON.stringify(LOCATION_ANSWER) : "pong" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      if (request.url === "https://api.voyageai.com/v1/embeddings") {
        const input = body.input as string[];
        return Response.json({
          data: input.map((_, index) => ({ index, embedding: new Array(1024).fill(0.5) })),
          usage: { total_tokens: 7 },
        });
      }
      if (request.url === "https://api.resend.com/emails") return Response.json({ id: "alert-1" });
      return new Response(`unexpected outbound fetch in test: ${request.url}`, { status: 599 });
    });
  }, 30_000);
  afterAll(() => worker?.dispose());

  it("sends a model call with the binding's key, the node:crypto session id and the Buffer's base64", async () => {
    expect(await worker.probe("llm")).toEqual({ ok: true, value: "pong" });

    const { auth, body } = last();
    expect(auth).toBe(`Bearer ${KEYS.OPENROUTER_API_KEY}`);
    // sha256("anthropic/claude-haiku-5.5\nrubric"), first 40 hex: what node:crypto produced before.
    expect(body.session_id).toBe("cache-7dfd9377896b30b5e90109de35e9abeaa4d83d56");
    const [pdf] = (body.messages as { content: { source: { data: string } }[] }[])[0]!.content;
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256);
    expect(pdf!.source.data).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("fails with the not-set message when no key is passed: there is no environment to fall back on", async () => {
    const before = seen.length;
    const result = await worker.probe("llm-no-key");
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("OPENROUTER_API_KEY is not set");
    expect(seen).toHaveLength(before);
  });

  it("embeds with the binding's key", async () => {
    expect(await worker.probe("embeddings")).toEqual({
      ok: true,
      value: { vectors: 2, width: 1024, usage: { totalTokens: 7 } },
    });
    expect(last().auth).toBe(`Bearer ${KEYS.VOYAGE_API_KEY}`);
  });

  it("names a location request as node:crypto did, and answers it through the model", async () => {
    expect(await worker.probe("locations")).toEqual({
      ok: true,
      value: {
        // sha256("Columbus, OH"), first 32 hex.
        id: `v${PROMPT_VERSION}-7-217ee5381a68c1156f31622b21385ee6`,
        answer: {
          status: "answered",
          text: JSON.stringify(LOCATION_ANSWER),
          spend: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0,
          },
        },
      },
    });
    expect(last().auth).toBe(`Bearer ${KEYS.OPENROUTER_API_KEY}`);
  });

  it("sends an alert through the Resend SDK with the passed key and addresses", async () => {
    expect(await worker.probe("email")).toEqual({ ok: true, value: { emailId: "alert-1" } });
    const { auth, body } = last();
    expect(auth).toBe(`Bearer ${KEYS.RESEND_API_KEY}`);
    expect(body).toMatchObject({ from: KEYS.EMAIL_FROM, to: KEYS.ALERT_TO });
  });
});
