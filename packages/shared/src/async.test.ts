import { afterEach, describe, expect, it, vi } from "vitest";

import { backoffDelayMs, parseRetryAfterMs } from "./async";

describe("parseRetryAfterMs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["5", 5000],
    ["0", 0], // "retry immediately", not a parse failure
    ["-5", undefined],
    ["soon", undefined],
    ["", undefined],
    [null, undefined],
  ])("reads %j as %j ms", (header, ms) => {
    expect(parseRetryAfterMs(header)).toBe(ms);
  });

  it("reads an HTTP-date as the time left until it, and a past date as absent", () => {
    vi.useFakeTimers({ now: Date.parse("Wed, 21 Oct 2026 07:28:00 GMT") });
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:45 GMT")).toBe(45_000);
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:27:00 GMT")).toBeUndefined();
  });
});

describe("backoffDelayMs", () => {
  it("lets a usable Retry-After win, capped at 30s", () => {
    expect(backoffDelayMs(3, "1")).toBe(1000);
    expect(backoffDelayMs(0, "120")).toBe(30_000);
  });

  it("falls back to 2s doubling per attempt, capped at 15s", () => {
    expect(backoffDelayMs(1, "soon")).toBe(4000);
    expect(backoffDelayMs(10)).toBe(15_000);
  });
});
