/**
 * Unit suite for the health-route authorization gate (auth.ts `isAuthorized`). Pins the secure-default
 * (unset token → nobody authorized), the Bearer-header and ?token= paths, and Bearer precedence over the
 * query param. Reads HEALTH_PING_TOKEN at CALL time, so each case stubs the env and restores in afterEach.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { isAuthorized } from "./auth";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://ops.test/api/health", { headers });
}
function url(query = ""): URL {
  return new URL(`https://ops.test/api/health${query}`);
}

describe("isAuthorized", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("denies everyone when HEALTH_PING_TOKEN is unset (secure default), even a matching-looking request", () => {
    vi.stubEnv("HEALTH_PING_TOKEN", ""); // unset / empty → falsy
    expect(isAuthorized(req({ authorization: "Bearer anything" }), url("?token=anything"))).toBe(false);
  });

  it("authorizes a correct Bearer token", () => {
    vi.stubEnv("HEALTH_PING_TOKEN", "s3cret");
    expect(isAuthorized(req({ authorization: "Bearer s3cret" }), url())).toBe(true);
  });

  it("rejects a wrong Bearer token", () => {
    vi.stubEnv("HEALTH_PING_TOKEN", "s3cret");
    expect(isAuthorized(req({ authorization: "Bearer nope" }), url())).toBe(false);
  });

  it("authorizes a correct ?token= query when there is no Bearer header", () => {
    vi.stubEnv("HEALTH_PING_TOKEN", "s3cret");
    expect(isAuthorized(req(), url("?token=s3cret"))).toBe(true);
  });

  it("rejects a wrong ?token= query", () => {
    vi.stubEnv("HEALTH_PING_TOKEN", "s3cret");
    expect(isAuthorized(req(), url("?token=nope"))).toBe(false);
  });

  it("prefers the Bearer header over ?token= (a valid query cannot rescue a wrong bearer)", () => {
    vi.stubEnv("HEALTH_PING_TOKEN", "s3cret");
    expect(isAuthorized(req({ authorization: "Bearer wrong" }), url("?token=s3cret"))).toBe(false);
    expect(isAuthorized(req({ authorization: "Bearer s3cret" }), url("?token=wrong"))).toBe(true);
  });

  it("falls back to ?token= when the Authorization header is not a Bearer scheme", () => {
    vi.stubEnv("HEALTH_PING_TOKEN", "s3cret");
    expect(isAuthorized(req({ authorization: "Basic s3cret" }), url("?token=s3cret"))).toBe(true);
    expect(isAuthorized(req({ authorization: "Basic s3cret" }), url())).toBe(false);
  });
});
