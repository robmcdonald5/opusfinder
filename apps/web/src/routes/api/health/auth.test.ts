/**
 * Unit suite for the health-route authorization gate (auth.ts `isAuthorized`). Pins the secure-default
 * (unset token → nobody authorized), the Bearer-header path, and that the token is never read from the URL.
 * Reads HEALTH_PING_TOKEN at CALL time, so each case stubs the env and restores in afterEach.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { isAuthorized } from "./auth";

function req(headers: Record<string, string> = {}, query = ""): Request {
  return new Request(`https://ops.test/api/health${query}`, { headers });
}

describe("isAuthorized", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("denies everyone when HEALTH_PING_TOKEN is unset or empty (secure default), even a matching-looking request", () => {
    vi.stubEnv("HEALTH_PING_TOKEN", undefined);
    expect(isAuthorized(req({ authorization: "Bearer undefined" }))).toBe(false);
    vi.stubEnv("HEALTH_PING_TOKEN", "");
    expect(isAuthorized(req({ authorization: "Bearer" }))).toBe(false);
  });

  it("authorizes a correct Bearer token", () => {
    vi.stubEnv("HEALTH_PING_TOKEN", "s3cret");
    expect(isAuthorized(req({ authorization: "Bearer s3cret" }))).toBe(true);
  });

  it("ignores surrounding whitespace in the stored token (a pasted trailing newline)", () => {
    vi.stubEnv("HEALTH_PING_TOKEN", "s3cret\n");
    expect(isAuthorized(req({ authorization: "Bearer s3cret" }))).toBe(true);
  });

  it("rejects a wrong Bearer token or a non-Bearer scheme", () => {
    vi.stubEnv("HEALTH_PING_TOKEN", "s3cret");
    expect(isAuthorized(req({ authorization: "Bearer nope" }))).toBe(false);
    expect(isAuthorized(req({ authorization: "Basic s3cret" }))).toBe(false);
  });

  it("never reads the token from the URL, which lands in request logs", () => {
    vi.stubEnv("HEALTH_PING_TOKEN", "s3cret");
    expect(isAuthorized(req({}, "?token=s3cret"))).toBe(false);
  });
});
