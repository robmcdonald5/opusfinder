import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { anthropicMessage } from "@test/msw/fixtures/anthropic";
import { server } from "@test/msw/server";
import { rejectionOf } from "@test/rejection";

import { transcribeCv } from "./cv-extract";

// Anything but a natural stop must throw. The wire stop_reason → finishReason mapping is
// @ai-sdk/anthropic's, so this runs over MSW rather than stubbing generate().

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function respondWith(stopReason: string) {
  server.use(
    http.post(MESSAGES_URL, () =>
      HttpResponse.json({
        ...anthropicMessage({ text: "Senior engineer, Go" }),
        stop_reason: stopReason,
      }),
    ),
  );
}

describe("transcribeCv — stop-reason gate over MSW", () => {
  beforeAll(() => vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test"));
  afterAll(() => vi.unstubAllEnvs());

  it("returns the transcript when the model ends its turn", async () => {
    respondWith("end_turn");
    expect(await transcribeCv(PDF)).toBe("Senior engineer, Go");
  });

  it.each([
    ["max_tokens", "length"],
    ["refusal", "content-filter"],
    ["model_context_window_exceeded", "unknown"],
  ])("rejects a transcript that stopped with %s", async (stopReason, finishReason) => {
    respondWith(stopReason);
    const err = await rejectionOf(transcribeCv(PDF));
    expect(err.message).toContain(`"${finishReason}"`);
  });
});
