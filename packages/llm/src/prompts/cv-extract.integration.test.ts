import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { messagesReply, OPENROUTER_MESSAGES_URL } from "@test/msw/fixtures/openrouter";
import { server } from "@test/msw/server";
import { rejectionOf } from "@test/rejection";

import { transcribeCv } from "./cv-extract";

// A cached transcript is permanent, so anything but a natural stop must throw. Runs over MSW so the wire
// stop_reason reaches the gate exactly as OpenRouter sends it.

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function respondWith(stopReason: string) {
  server.use(
    http.post(OPENROUTER_MESSAGES_URL, () =>
      HttpResponse.json({
        ...messagesReply({ text: "Senior engineer, Go" }),
        stop_reason: stopReason,
      }),
    ),
  );
}

describe("transcribeCv — stop-reason gate over MSW", () => {
  beforeAll(() => vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test"));
  afterAll(() => vi.unstubAllEnvs());

  it("returns the transcript when the model ends its turn", async () => {
    respondWith("end_turn");
    expect(await transcribeCv(PDF)).toBe("Senior engineer, Go");
  });

  it.each(["max_tokens", "refusal", "model_context_window_exceeded"])(
    "rejects a transcript that stopped with %s",
    async (stopReason) => {
      respondWith(stopReason);
      const err = await rejectionOf(transcribeCv(PDF));
      expect(err.message).toContain(`transcription stopped with "${stopReason}"`);
    },
  );
});
