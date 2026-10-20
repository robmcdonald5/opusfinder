import { delay, http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { messagesReply, OPENROUTER_MESSAGES_URL } from "@test/msw/fixtures/openrouter";
import { server } from "@test/msw/server";
import { rejectionOf } from "@test/rejection";

import { OpenRouterError, openRouterRequest } from "./openrouter";

// The one transport every model call uses, over MSW. Pins the credential boundary (the OpenRouter key as a
// Bearer token, and NOTHING from the Anthropic SDK's environment variables, which this transport exists to
// keep out of requests to another vendor), which failures retry — including an error OpenRouter reports
// inside a 200, after the provider accepted the request — and that an error carries the status and type but
// never a body. The shared backoff is mocked instant. A retried status is served with a null body: the
// transport cancels a retried reply's body, and cancelling an MSW-mocked body deadlocks.
vi.mock("@opusfinder/shared/async", () => ({ backoff: vi.fn(async () => {}) }));

/** OpenRouter's Messages error envelope, as sent in a 200 when a provider fails after acceptance. */
function envelope(errorType: string) {
  return {
    type: "error",
    error: {
      type: "overloaded_error",
      message: "Provider is temporarily overloaded",
      error_type: errorType,
    },
    request_id: "gen-test",
  };
}

describe("openRouterRequest", () => {
  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-should-not-leak");
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "X-Leak: yes");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends the OpenRouter key as a Bearer token and no Anthropic credentials or headers", async () => {
    let headers: Headers | undefined;
    server.use(
      http.post(OPENROUTER_MESSAGES_URL, ({ request }) => {
        headers = request.headers;
        return HttpResponse.json(messagesReply());
      }),
    );

    await openRouterRequest("POST", "/messages", { max_tokens: 1 });

    expect(headers?.get("authorization")).toBe("Bearer sk-or-test");
    expect(headers?.get("x-api-key")).toBeNull();
    expect(headers?.get("x-leak")).toBeNull();
    expect(headers?.get("anthropic-version")).toBeNull();
  });

  it("retries a 429 and a 5xx, then returns the parsed reply", async () => {
    const statuses = [429, 503];
    let hits = 0;
    server.use(
      http.post(OPENROUTER_MESSAGES_URL, () => {
        const status = statuses[hits++];
        return status
          ? new HttpResponse(null, { status, headers: { "retry-after": "0" } })
          : HttpResponse.json(messagesReply({ text: "third time" }));
      }),
    );

    const reply = await openRouterRequest<{ content: { text: string }[] }>("POST", "/messages", {});

    expect(hits).toBe(3);
    expect(reply.content[0]?.text).toBe("third time");
  });

  it("does not retry a 400, and throws the status, type and capped message without the body", async () => {
    let hits = 0;
    server.use(
      http.post(OPENROUTER_MESSAGES_URL, () => {
        hits += 1;
        return HttpResponse.json(
          {
            type: "error",
            error: { type: "invalid_request_error", message: `bad ${"x".repeat(500)}` },
            request_id: "r",
          },
          { status: 400 },
        );
      }),
    );

    const err = await rejectionOf(openRouterRequest("POST", "/messages", {}));

    expect(hits).toBe(1);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err).toMatchObject({ status: 400, type: "invalid_request_error" });
    expect(err.message).toBe(`OpenRouter 400 invalid_request_error: bad ${"x".repeat(296)}`);
  });

  it("retries a transient error reported inside a 200, then returns the reply", async () => {
    let hits = 0;
    server.use(
      http.post(OPENROUTER_MESSAGES_URL, () =>
        HttpResponse.json(
          hits++ === 0 ? envelope("provider_overloaded") : messagesReply({ text: "ok" }),
        ),
      ),
    );

    const reply = await openRouterRequest<{ content: { text: string }[] }>("POST", "/messages", {});

    expect(hits).toBe(2);
    expect(reply.content[0]?.text).toBe("ok");
  });

  it("throws a non-transient error reported inside a 200 without retrying", async () => {
    let hits = 0;
    server.use(
      http.post(OPENROUTER_MESSAGES_URL, () => {
        hits += 1;
        return HttpResponse.json(envelope("content_policy_violation"));
      }),
    );

    const err = await rejectionOf(openRouterRequest("POST", "/messages", {}));

    expect(hits).toBe(1);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err).toMatchObject({ status: 200, type: "content_policy_violation" });
  });

  it("throws on a 200 that isn't JSON without echoing the reply", async () => {
    server.use(
      http.post(OPENROUTER_MESSAGES_URL, () =>
        HttpResponse.text("<html>transcript fragment</html>"),
      ),
    );

    const err = await rejectionOf(openRouterRequest("POST", "/messages", {}));

    expect(err.message).toBe("OpenRouter 200 invalid_json: the reply is not JSON");
  });

  it("makes a single attempt when maxRetries is 0", async () => {
    let hits = 0;
    server.use(
      http.post(OPENROUTER_MESSAGES_URL, () => {
        hits += 1;
        return HttpResponse.json({ error: { code: 503, message: "busy" } }, { status: 503 });
      }),
    );

    const err = await rejectionOf(openRouterRequest("POST", "/messages", {}, { maxRetries: 0 }));

    expect(hits).toBe(1);
    expect(err).toMatchObject({ status: 503 });
  });

  it("stops at the caller's deadline: cancels the attempt in flight and retries nothing", async () => {
    let hits = 0;
    server.use(
      http.post(OPENROUTER_MESSAGES_URL, async () => {
        hits += 1;
        await delay("infinite");
        return HttpResponse.json(messagesReply());
      }),
    );

    const err = await rejectionOf(
      openRouterRequest("POST", "/messages", {}, { signal: AbortSignal.timeout(50) }),
    );

    expect(hits).toBe(1);
    expect(err).toMatchObject({ name: "TimeoutError" });
  });

  it("gives up after the retries on a persistent 5xx, reading the last reply's error", async () => {
    let hits = 0;
    server.use(
      http.post(OPENROUTER_MESSAGES_URL, () => {
        hits += 1;
        return hits < 3
          ? new HttpResponse(null, { status: 502, headers: { "retry-after": "0" } })
          : HttpResponse.json({ error: { code: 502, message: "upstream" } }, { status: 502 });
      }),
    );

    const err = await rejectionOf(openRouterRequest("POST", "/messages", {}));

    expect(hits).toBe(3);
    expect(err).toMatchObject({ status: 502, message: "OpenRouter 502 error: upstream" });
  });
});
