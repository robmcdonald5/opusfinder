import { describe, expect, it, vi } from "vitest";

import { authConfig, normalizeTeamDomain } from "./auth-config";

// Parsing the identity secrets: once per isolate per distinct value, so a malformed SERVICE_TOKENS is
// logged once — not on every request — and never with its contents.

const BASE = {
  ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
  ACCESS_AUD: "aud",
  OWNER_EMAILS: "Owner@Example.com, second@example.com",
};

describe("authConfig", () => {
  it("parses owners (normalized) and service tokens", () => {
    const cfg = authConfig({
      ...BASE,
      SERVICE_TOKENS: JSON.stringify({ "a.access": { role: "agent", name: "observer" } }),
    });
    expect(cfg?.owners).toEqual(new Set(["owner@example.com", "second@example.com"]));
    expect(cfg?.tokens.get("a.access")).toEqual({ role: "agent", name: "observer" });
  });

  it("parses a malformed SERVICE_TOKENS once per value and logs its shape, not its content", () => {
    const log = vi.fn();
    const secret = '{"secret-client-id.access": not json';
    for (let i = 0; i < 25; i++) {
      expect(authConfig({ ...BASE, SERVICE_TOKENS: secret }, log)?.tokens.size).toBe(0);
    }
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/not valid JSON \(length \d+\)/);
    expect(log.mock.calls[0]?.[0]).not.toContain("secret-client-id");
  });

  it("re-parses when a secret value changes", () => {
    const log = vi.fn();
    authConfig({ ...BASE, SERVICE_TOKENS: "[1]" }, log);
    authConfig({ ...BASE, SERVICE_TOKENS: "[2]" }, log);
    expect(log).toHaveBeenCalledTimes(2);
    const fixed = authConfig(
      { ...BASE, SERVICE_TOKENS: JSON.stringify({ "b.access": { role: "runtime", name: "rt" } }) },
      log,
    );
    expect(fixed?.tokens.get("b.access")?.role).toBe("runtime");
  });

  it("skips malformed entries but keeps the good ones", () => {
    const log = vi.fn();
    const cfg = authConfig(
      {
        ...BASE,
        SERVICE_TOKENS: JSON.stringify({
          "ok.access": { role: "agent", name: "fine" },
          "bad-role.access": { role: "owner", name: "x" },
          "bad-name.access": { role: "agent", name: "has spaces" },
        }),
      },
      log,
    );
    expect([...(cfg?.tokens.keys() ?? [])]).toEqual(["ok.access"]);
    expect(log).toHaveBeenCalledWith("SERVICE_TOKENS: ignored 2 malformed entr(y/ies)");
  });

  it("fails closed without a valid team domain or AUD", () => {
    expect(authConfig({ ...BASE, ACCESS_AUD: undefined })).toBeNull();
    expect(authConfig({ ...BASE, ACCESS_TEAM_DOMAIN: "https://keys.example.com" })).toBeNull();
    expect(normalizeTeamDomain("Team.CloudflareAccess.com/")).toBe(
      "https://team.cloudflareaccess.com",
    );
  });
});
