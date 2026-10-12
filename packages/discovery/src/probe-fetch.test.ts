import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobsRequest } from "@opusfinder/sources";

import { fakeResponse } from "../test/http-stubs";
import { probeFetch } from "./probe";

// Leaf pure-unit for the non-throwing probe fetch loop. `probeFetch` NEVER throws: every HTTP
// response (and a network-exhausted attempt) resolves to `{ status, body }`. Locks the four
// status/body extraction paths (2xx JSON, non-2xx, non-JSON 2xx, network-exhausted) plus the
// transient retry: a 429/5xx is retried through the shared `backoff`, and a `Retry-After` header
// wins over the default exponential wait. `fetch` is stubbed (no network) and the backoff sleeps
// are driven with FAKE timers via the ASYNC advance api — the sync advance would not flush the
// awaited fetch/backoff promises. Ports scripts/test-probe.ts (the probeFetch half).

const req = (url: string): JobsRequest => ({ url });

describe("probeFetch", () => {
  // The current fetch stub's response producer; each test swaps this in.
  let handler: (url: string) => Response;
  // Every URL fetch was invoked with, in order — asserts the retry re-issues the request.
  let fetchCalls: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    handler = () => {
      throw new Error("no handler set");
    };
    fetchCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        fetchCalls.push(String(url));
        return handler(String(url));
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a 2xx JSON body → status 200 + parsed body", async () => {
    handler = () => fakeResponse(200, JSON.stringify({ jobs: [{ id: 1 }] }));

    const result = await probeFetch(req("https://x/y"));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ jobs: [{ id: 1 }] });
  });

  it("a non-2xx (404) → status 404 + undefined body (body cancelled, not buffered)", async () => {
    // Spy the body drain + text read to PROVE the name's claim: a 404 body is cancelled, never buffered.
    const cancel = vi.fn(() => Promise.resolve());
    const text = vi.fn(() => Promise.resolve("Not Found"));
    handler = () =>
      ({
        status: 404,
        headers: { get: () => null },
        text,
        body: { cancel },
      }) as unknown as Response;

    const result = await probeFetch(req("https://x/y"));

    expect(result.status).toBe(404);
    expect(result.body).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1); // drained…
    expect(text).not.toHaveBeenCalled(); // …not buffered
  });

  it("a 2xx non-JSON body → status 200 + undefined body (never throws on bad JSON)", async () => {
    handler = () => fakeResponse(200, "<html>nope</html>");

    const result = await probeFetch(req("https://x/y"));

    expect(result.status).toBe(200);
    expect(result.body).toBeUndefined();
  });

  it("a transient 503 then 200 (maxRetries 3) → retried once, returns 200", async () => {
    let calls = 0;
    handler = () =>
      calls++ === 0 ? fakeResponse(503, "busy") : fakeResponse(200, JSON.stringify({ ok: true }));

    const promise = probeFetch(req("https://x/y"), 3);
    // The backoff sleeps on a REAL setTimeout — drain every scheduled timer (jitter included).
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.status).toBe(200);
    expect(fetchCalls).toHaveLength(2);
  });

  it("honors a Retry-After header before the retry", async () => {
    let calls = 0;
    handler = () =>
      calls++ === 0
        ? fakeResponse(503, "busy", "5") // Retry-After: 5s
        : fakeResponse(200, JSON.stringify({ ok: true }));

    const promise = probeFetch(req("https://x/y"), 3);
    // Discriminating gap: the default attempt-0 backoff maxes at ~2.25s (2000 + <250ms jitter); the 5s
    // Retry-After must WIN (~5000-5250ms). Advance PAST the default ceiling but BEFORE 5s — a retry here
    // would mean Retry-After was ignored (the default timer already elapsed). This is what catches the
    // regression; advancing only 2000ms fires neither timer and proves nothing.
    await vi.advanceTimersByTimeAsync(3500);
    expect(fetchCalls).toHaveLength(1);

    // Past the 5s Retry-After (plus jitter) → the retry fires and succeeds.
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.status).toBe(200);
    expect(fetchCalls).toHaveLength(2);
  });

  it("fails fast: a 429 whose Retry-After exceeds maxRetryWaitMs returns at once, unretried", async () => {
    handler = () => fakeResponse(429, "slow down", "30");

    // No timer is advanced: a sleep on the 30 s Retry-After would never settle.
    const result = await probeFetch(req("https://x/y"), 3, 5_000);

    expect(result).toEqual({ status: 429, body: undefined });
    expect(fetchCalls).toHaveLength(1);
  });

  it("aborts a request that never answers via its timeout → status 0, so a hung host can't hold the probe", async () => {
    // Only the request's abort signal can settle this fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    // AbortSignal.timeout runs on Node's internal (real) timers; route it through the fake clock.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    try {
      const promise = probeFetch(req("https://x/y"), 0);
      await vi.runAllTimersAsync();

      expect(await promise).toEqual({ status: 0, body: undefined });
    } finally {
      timeout.mockRestore();
    }
  });

  it("a 2xx whose body read fails (e.g. the timeout firing mid-stream) → status 0, never a throw", async () => {
    handler = () =>
      ({
        status: 200,
        headers: { get: () => null },
        text: () => Promise.reject(new Error("aborted")),
      }) as unknown as Response;

    expect(await probeFetch(req("https://x/y"), 0)).toEqual({ status: 0, body: undefined });
  });

  it("a network throw with maxRetries 0 → status 0 (network-exhausted)", async () => {
    handler = () => {
      throw new Error("ECONNRESET");
    };

    const result = await probeFetch(req("https://x/y"), 0);

    expect(result.status).toBe(0);
    expect(result.body).toBeUndefined();
    expect(fetchCalls).toHaveLength(1); // no retry when maxRetries is 0
  });
});
