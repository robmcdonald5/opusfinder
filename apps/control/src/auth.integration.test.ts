import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_CLIENT_ID,
  AccessKeys,
  DEFAULT_BINDINGS,
  OWNER_EMAIL,
  TEAM_DOMAIN,
  startControl,
  type ControlHarness,
} from "@test/control/harness";

// Role detection is the T2 boundary's other half (classify() is the first): a caller is whatever its
// VERIFIED Access token says, and anything not positively recognised is refused. Every case below runs
// the real Worker in workerd against the production verification code — only the JWKS network fetch is
// served by the harness.

let h: ControlHarness;
beforeAll(async () => {
  h = await startControl();
}, 60_000);
afterAll(async () => {
  await h?.dispose();
});
beforeEach(async () => {
  await h.reset();
});

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

async function callerOf(res: Response): Promise<unknown> {
  return ((await res.json()) as { caller: unknown }).caller;
}

describe("default deny: no verified Access identity, nothing", () => {
  it.each(["/v1/status", "/v1/gate/ingest", "/v1/proposals", "/", "/no-such-route"])(
    "refuses an unauthenticated GET %s with 401 (before routing — even a 404 is hidden)",
    async (path) => {
      const res = await h.request(path, { as: null });
      expect(res.status).toBe(401);
    },
  );

  it("refuses an unauthenticated write and changes nothing", async () => {
    const res = await h.request("/v1/changes", {
      as: null,
      json: { target: "embed", value: "on", reason: "x" },
    });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthenticated");
    const row = await h.db
      .prepare("SELECT value FROM state WHERE key = 'embed'")
      .first<{ value: string }>();
    expect(row?.value).toBe("off");
  });

  it("ignores identity-looking headers that aren't a signed token", async () => {
    const res = await h.request("/v1/status", {
      as: null,
      headers: {
        "cf-access-authenticated-user-email": OWNER_EMAIL,
        "cf-access-client-id": AGENT_CLIENT_ID,
        cookie: "CF_Authorization=not-a-token",
      },
    });
    expect(res.status).toBe(401);
  });

  it("refuses a service binding's plain fetch: binding traffic carries no Access identity", async () => {
    const res = await h.bindingFetch("/v1/status");
    expect(res.status).toBe(401);
  });
});

describe("role mapping from a verified token", () => {
  it("maps an owner-listed human email to owner (case/whitespace-insensitive)", async () => {
    const res = await h.request("/v1/status", { as: "owner" });
    expect(res.status).toBe(200);
    expect(await callerOf(res)).toEqual({ role: "owner", name: OWNER_EMAIL });
  });

  it("refuses a human Access let in who isn't on the owner list (403, not a lesser role)", async () => {
    const token = await h.keys.sign(AccessKeys.humanClaims("someone-else@example.com"));
    const res = await h.request("/v1/status", { as: { token } });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("not_owner");
  });

  it("maps a configured service token to its role and name", async () => {
    expect(await callerOf(await h.request("/v1/status", { as: "agent" }))).toEqual({
      role: "agent",
      name: "observer",
    });
    const gate = await h.request("/v1/gate/ingest", { as: "runtime" });
    expect(gate.status).toBe(200);
  });

  it("refuses a service token Access accepted but SERVICE_TOKENS doesn't list", async () => {
    const token = await h.keys.sign(AccessKeys.serviceClaims("unknown-client.access"));
    const res = await h.request("/v1/gate/ingest", { as: { token } });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("unknown_service_token");
  });

  it("never escalates a service token to owner via an email claim", async () => {
    // common_name wins: an unlisted client id is refused even if the token also carries the owner's email.
    const token = await h.keys.sign(
      AccessKeys.serviceClaims("unknown-client.access", { email: OWNER_EMAIL }),
    );
    expect((await h.request("/v1/status", { as: { token } })).status).toBe(403);
    // …and a listed agent token carrying the owner's email is still just the agent.
    const agentWithEmail = await h.keys.sign(
      AccessKeys.serviceClaims(AGENT_CLIENT_ID, { email: OWNER_EMAIL }),
    );
    expect(
      await callerOf(await h.request("/v1/status", { as: { token: agentWithEmail } })),
    ).toEqual({
      role: "agent",
      name: "observer",
    });
  });

  it("refuses a human token with no subject", async () => {
    const token = await h.keys.sign(AccessKeys.humanClaims(OWNER_EMAIL, { sub: "" }));
    const res = await h.request("/v1/status", { as: { token } });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unrecognised_identity");
  });
});

describe("token verification: forged or stale tokens are refused (401)", () => {
  const now = () => Math.floor(Date.now() / 1000);

  it.each<[string, () => Promise<string>]>([
    [
      "signed by a different key under the published kid",
      async () => {
        const other = await AccessKeys.create();
        return other.sign(AccessKeys.humanClaims(OWNER_EMAIL), { kid: h.keys.kid });
      },
    ],
    [
      "for another Access application (wrong aud)",
      () => h.keys.sign(AccessKeys.humanClaims(OWNER_EMAIL, { aud: ["other-app"] })),
    ],
    [
      "from another team (wrong iss)",
      () =>
        h.keys.sign(
          AccessKeys.humanClaims(OWNER_EMAIL, { iss: "https://evil.cloudflareaccess.com" }),
        ),
    ],
    ["expired", () => h.keys.sign(AccessKeys.humanClaims(OWNER_EMAIL, { exp: now() - 120 }))],
    ["with no exp", () => h.keys.sign(AccessKeys.humanClaims(OWNER_EMAIL, { exp: undefined }))],
    [
      "not yet valid (nbf in the future)",
      () => h.keys.sign(AccessKeys.humanClaims(OWNER_EMAIL, { nbf: now() + 3600 })),
    ],
    [
      "a global session token, not an app token",
      () => h.keys.sign(AccessKeys.humanClaims(OWNER_EMAIL, { type: "org" })),
    ],
    [
      "claiming alg HS256",
      () => h.keys.sign(AccessKeys.humanClaims(OWNER_EMAIL), { alg: "HS256" }),
    ],
  ])("refuses a token %s", async (_label, mint) => {
    const res = await h.request("/v1/status", { as: { token: await mint() } });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("invalid_token");
  });

  it("refuses an unsigned alg:none token", async () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${enc({ alg: "none", kid: h.keys.kid })}.${enc(AccessKeys.humanClaims(OWNER_EMAIL))}.`;
    const res = await h.request("/v1/status", { as: { token } });
    expect(res.status).toBe(401);
  });

  it.each(["", "a.b", "a.b.c.d", "!!!.###.$$$", "x".repeat(9000)])(
    "refuses the malformed token %#",
    async (token) => {
      const res = await h.request("/v1/status", { as: { token } });
      expect(res.status).toBe(401);
    },
  );

  it("refuses an unknown kid, refetching the JWKS at most once per refresh window", async () => {
    const before = h.jwksFetches();
    for (let i = 0; i < 5; i++) {
      const token = await h.keys.sign(AccessKeys.humanClaims(OWNER_EMAIL), { kid: `rotated-${i}` });
      expect((await h.request("/v1/status", { as: { token } })).status).toBe(401);
    }
    expect(h.jwksFetches() - before).toBeLessThanOrEqual(1);
  });
});

describe("route permissions by role (default deny per route)", () => {
  it.each<[string, "owner" | "agent" | "runtime", string, unknown]>([
    ["agent can't approve", "agent", "/v1/proposals/1/approve", {}],
    ["agent can't reject", "agent", "/v1/proposals/1/reject", {}],
    [
      "agent can't write ledger rows",
      "agent",
      "/v1/runs",
      { stage: "ingest", outcome: "ok", startedAt: new Date().toISOString() },
    ],
    ["agent can't trip", "agent", "/v1/trip", { stage: "ingest", reason: "runaway" }],
    [
      "runtime can't change desired state",
      "runtime",
      "/v1/changes",
      { target: "ingest", value: "off", reason: "x" },
    ],
    [
      "runtime can't propose",
      "runtime",
      "/v1/proposals",
      { target: "embed", value: "on", reason: "x" },
    ],
    [
      "owner can't write ledger rows",
      "owner",
      "/v1/runs",
      { stage: "ingest", outcome: "ok", startedAt: new Date().toISOString() },
    ],
  ])("%s", async (_label, as, path, json) => {
    const res = await h.request(path, { as, json });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden");
  });

  it.each(["/v1/status", "/v1/proposals"])("runtime can't read %s (gates only)", async (path) => {
    expect((await h.request(path, { as: "runtime" })).status).toBe(403);
  });

  it("runtime can't load the page; the owner's form routes refuse agents", async () => {
    expect((await h.request("/", { as: "runtime" })).status).toBe(403);
    const res = await h.request("/ui/change", {
      as: "agent",
      form: { target: "embed", value: "on", reason: "x" },
    });
    expect(res.status).toBe(403);
  });

  it("answers an authenticated unknown route with 404 and a wrong method with 405", async () => {
    expect((await h.request("/v1/nope", { as: "owner" })).status).toBe(404);
    expect((await h.request("/v1/status", { as: "owner", method: "POST", json: {} })).status).toBe(
      405,
    );
  });
});

describe("fail-closed configuration", () => {
  it.each<[string, Record<string, string | undefined>]>([
    ["ACCESS_AUD unset", { ...DEFAULT_BINDINGS, ACCESS_AUD: undefined }],
    ["ACCESS_TEAM_DOMAIN unset", { ...DEFAULT_BINDINGS, ACCESS_TEAM_DOMAIN: undefined }],
    [
      "ACCESS_TEAM_DOMAIN not an Access domain",
      { ...DEFAULT_BINDINGS, ACCESS_TEAM_DOMAIN: "https://keys.example.com" },
    ],
  ])(
    "refuses every request with 503 when %s",
    async (_label, bindings) => {
      const misconfigured = await startControl(bindings);
      try {
        const token = await misconfigured.keys.sign(AccessKeys.humanClaims(OWNER_EMAIL));
        for (const path of ["/v1/status", "/v1/gate/ingest", "/"]) {
          const res = await misconfigured.request(path, { as: { token } });
          expect(res.status).toBe(503);
        }
      } finally {
        await misconfigured.dispose();
      }
    },
    60_000,
  );

  it("accepts no service token when SERVICE_TOKENS is malformed — and the owner still works", async () => {
    const misconfigured = await startControl({ ...DEFAULT_BINDINGS, SERVICE_TOKENS: "{not json" });
    try {
      expect((await misconfigured.request("/v1/status", { as: "agent" })).status).toBe(403);
      expect((await misconfigured.request("/v1/gate/ingest", { as: "runtime" })).status).toBe(403);
      expect((await misconfigured.request("/v1/status", { as: "owner" })).status).toBe(200);
    } finally {
      await misconfigured.dispose();
    }
  }, 60_000);

  it("maps no human to owner when OWNER_EMAILS is unset", async () => {
    const misconfigured = await startControl({ ...DEFAULT_BINDINGS, OWNER_EMAILS: undefined });
    try {
      expect((await misconfigured.request("/v1/status", { as: "owner" })).status).toBe(403);
      expect((await misconfigured.request("/v1/status", { as: "agent" })).status).toBe(200);
    } finally {
      await misconfigured.dispose();
    }
  }, 60_000);

  it("normalizes a team domain given without scheme or with a trailing slash", async () => {
    const lenient = await startControl({
      ...DEFAULT_BINDINGS,
      ACCESS_TEAM_DOMAIN: `${TEAM_DOMAIN.slice(8)}/`,
    });
    try {
      expect((await lenient.request("/v1/status", { as: "owner" })).status).toBe(200);
    } finally {
      await lenient.dispose();
    }
  }, 60_000);
});
