import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { messagesReply, OPENROUTER_MESSAGES_URL } from "@test/msw/fixtures/openrouter";
import { server } from "@test/msw/server";
import { rejectionOf } from "@test/rejection";

import { CV_EXTRACT_VERSION, structureCv, transcribeCv } from "./cv-extract";

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

beforeAll(() => vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test"));
afterAll(() => vi.unstubAllEnvs());

describe("transcribeCv — stop-reason gate over MSW", () => {
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

describe("structureCv", () => {
  const extracted = {
    summary: "Registered nurse with 14 years in medical-surgical care.",
    skills: ["wound care"],
    targetRoles: ["Registered Nurse"],
    facts: {
      credentials: [{ name: "Registered Nurse (RN)", issuer: null, status: null, expires: "2027" }],
      education: [{ level: "bachelor", field: "Nursing", completed: true }],
      yearsExperience: { total: 14, byRoleFamily: [] },
      languages: [],
      workAuthorization: null,
    },
  };

  it("returns the model's profile tagged with the extraction version", async () => {
    server.use(
      http.post(OPENROUTER_MESSAGES_URL, () =>
        HttpResponse.json(messagesReply({ text: JSON.stringify(extracted) })),
      ),
    );
    expect(await structureCv("RN Staff Nurse ...")).toEqual({
      ...extracted,
      extractVersion: CV_EXTRACT_VERSION,
    });
  });
});
