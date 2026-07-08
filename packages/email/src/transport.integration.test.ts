import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DigestEmailPayload } from "@opusfinder/db/repos";
import { server } from "@test/msw/server";

import { renderDigestEmail } from "./render";
import { emailIdempotencyKey, getEmailLastEvent, sendDigestEmail, sendHealthAlert } from "./transport";

// The Resend transport over MSW: request-shape (Authorization / Idempotency-Key / body) + the two-client
// least-privilege split (send key vs full read key) + shape-only, no-PII error mapping. Render is covered
// pure-unit (render.test.ts); here renderDigestEmail is an ORACLE — we assert the transport threads its
// output, not the HTML itself. The Resend SDK reads its key at client-CONSTRUCTION and both clients are
// module-memoized, so the four env vars are stubbed in beforeAll (distinct send/read keys prove the split)
// BEFORE any test triggers a client. onUnhandledRequest:"error" enforces zero live egress.

const RESEND = "https://api.resend.com";
const SEND_KEY = "re_send_key_1234";
const FULL_KEY = "re_full_key_5678";
const FROM = "opusfinder digest <digest@send.test>";
const ALERT_TO = "ops@example.test";
const USER_ID = "00000000-0000-0000-0000-000000000000" as DigestEmailPayload["userId"];

function makePayload(overrides: Partial<DigestEmailPayload> = {}): DigestEmailPayload {
  return {
    digestId: 42,
    userId: USER_ID,
    recipient: { email: "user@example.com", name: "User" },
    createdAt: new Date("2026-06-11T00:00:00Z"),
    approvedAt: new Date("2026-06-10T00:00:00Z"),
    items: [
      {
        rank: 1,
        reason: "Strong overlap.",
        title: "Senior Backend Engineer",
        companySlug: "acme",
        applyUrl: "https://boards.example.com/acme/jobs/1",
        locations: ["Berlin, Germany"],
        remote: false,
      },
    ],
    ...overrides,
  };
}

describe("Resend transport over MSW", () => {
  beforeAll(() => {
    vi.stubEnv("RESEND_API_KEY", SEND_KEY);
    vi.stubEnv("RESEND_API_KEY_FULL", FULL_KEY);
    vi.stubEnv("EMAIL_FROM", FROM);
    vi.stubEnv("ALERT_TO", ALERT_TO);
  });
  afterAll(() => vi.unstubAllEnvs());

  it("derives the idempotency key as digest/<id>", () => {
    expect(emailIdempotencyKey(42)).toBe("digest/42");
  });

  it("sends a digest with the exact Resend contract (send key, idempotency, rendered oracle)", async () => {
    const payload = makePayload();
    const rendered = renderDigestEmail(payload);
    let auth: string | null = null;
    let idempotency: string | null = null;
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(`${RESEND}/emails`, async ({ request }) => {
        auth = request.headers.get("authorization");
        idempotency = request.headers.get("idempotency-key");
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: "email-123" });
      }),
    );

    const result = await sendDigestEmail(payload);

    expect(result).toEqual({ emailId: "email-123" });
    expect(auth).toBe(`Bearer ${SEND_KEY}`);
    expect(idempotency).toBe("digest/42");
    expect(body).toMatchObject({
      from: FROM,
      to: "user@example.com",
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  });

  it("reads delivery state via the FULL read key and passes last_event through verbatim", async () => {
    let auth: string | null = null;
    server.use(
      http.get(`${RESEND}/emails/:id`, ({ request, params }) => {
        auth = request.headers.get("authorization");
        return HttpResponse.json({ id: params.id, last_event: "delivered" });
      }),
    );

    const event = await getEmailLastEvent("email-123");

    expect(event).toBe("delivered");
    expect(auth).toBe(`Bearer ${FULL_KEY}`); // the split: reads use the full-access key, not the send key
  });

  it("threads the sent email id into the delivery poll (send → get round-trip)", async () => {
    server.use(
      http.post(`${RESEND}/emails`, () => HttpResponse.json({ id: "email-round-trip" })),
      http.get(`${RESEND}/emails/:id`, ({ params }) =>
        HttpResponse.json({
          id: params.id,
          last_event: params.id === "email-round-trip" ? "opened" : "sent",
        }),
      ),
    );

    const { emailId } = await sendDigestEmail(makePayload());
    const event = await getEmailLastEvent(emailId);

    expect(emailId).toBe("email-round-trip");
    expect(event).toBe("opened");
  });

  it("sends a health alert to ALERT_TO with the send key, no html, and no idempotency key", async () => {
    let auth: string | null = null;
    let idempotency: string | null = null;
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(`${RESEND}/emails`, async ({ request }) => {
        auth = request.headers.get("authorization");
        idempotency = request.headers.get("idempotency-key");
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: "alert-1" });
      }),
    );

    const result = await sendHealthAlert("Health: DEGRADED", "3 checks failing");

    expect(result).toEqual({ emailId: "alert-1" });
    expect(auth).toBe(`Bearer ${SEND_KEY}`);
    expect(idempotency).toBeNull(); // an alert is not replay-idempotent — no key
    expect(body).toMatchObject({ from: FROM, to: ALERT_TO, subject: "Health: DEGRADED", text: "3 checks failing" });
    expect(body).not.toHaveProperty("html");
  });

  it("throws a shape-only error on a send failure (no recipient, no provider message)", async () => {
    server.use(
      http.post(`${RESEND}/emails`, () =>
        HttpResponse.json(
          { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests for user@example.com" },
          { status: 429 },
        ),
      ),
    );

    let err: Error | undefined;
    try {
      await sendDigestEmail(makePayload());
    } catch (e) {
      err = e as Error;
    }

    expect(err?.message).toBe("resend send failed: rate_limit_exceeded (status 429) for digest 42");
    expect(err?.message).not.toContain("user@example.com"); // no recipient leaked
    expect(err?.message).not.toContain("Too many requests"); // no provider message leaked
  });

  it("throws a shape-only error when the delivery poll is unauthorized", async () => {
    server.use(
      http.get(`${RESEND}/emails/:id`, () =>
        HttpResponse.json({ statusCode: 401, name: "restricted_api_key", message: "nope" }, { status: 401 }),
      ),
    );

    await expect(getEmailLastEvent("email-x")).rejects.toThrow(
      "resend get failed: restricted_api_key (status 401)",
    );
  });

  it("returns a terminal last_event like 'bounced' rather than throwing (policy lives upstream)", async () => {
    server.use(
      http.get(`${RESEND}/emails/:id`, ({ params }) =>
        HttpResponse.json({ id: params.id, last_event: "bounced" }),
      ),
    );

    await expect(getEmailLastEvent("email-x")).resolves.toBe("bounced");
  });

  it("throws a distinct shape-only error on an alert-send failure (no operator address, no message)", async () => {
    server.use(
      http.post(`${RESEND}/emails`, () =>
        HttpResponse.json(
          { statusCode: 500, name: "application_error", message: "delivery to ops@example.test failed" },
          { status: 500 },
        ),
      ),
    );

    let err: Error | undefined;
    try {
      await sendHealthAlert("subject", "text");
    } catch (e) {
      err = e as Error;
    }

    expect(err?.message).toBe("resend alert send failed: application_error (status 500)");
    expect(err?.message).not.toContain("ops@example.test");
    expect(err?.message).not.toContain("delivery to");
  });
});
