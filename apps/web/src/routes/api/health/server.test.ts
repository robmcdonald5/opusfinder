/**
 * Unit suite for the health GET route handler (+server.ts). The db + checkHealth are module-mocked (no real
 * Neon), @sveltejs/kit's `json` is stubbed to a plain Response, and isAuthorized reads HEALTH_PING_TOKEN.
 * Pins the two axes the handler owns: report.unhealthy → 200/503 status (returned to EVERYONE), and the
 * body gate (full report only when authorized, else the minimal `{ unhealthy }` — no operational-intel leak).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@opusfinder/db", () => ({ createDb: vi.fn(() => ({})) }));
vi.mock("@opusfinder/db/env", () => ({ getDatabaseUrl: vi.fn(() => "postgres://stub") }));
vi.mock("@opusfinder/db/health", () => ({
  checkHealth: vi.fn(),
  healthOptionsFromEnv: vi.fn(() => ({})),
}));
vi.mock("@sveltejs/kit", () => ({
  json: (body: unknown, init?: { status?: number }) =>
    new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
}));

import { checkHealth } from "@opusfinder/db/health";

import { GET } from "./+server";

const FULL_REPORT = { unhealthy: false, embeddingBacklog: 5, bounceSuppressed: 2 };

function callGET(headers: Record<string, string> = {}, query = ""): Promise<Response> {
  const request = new Request(`https://ops.test/api/health${query}`, { headers });
  const url = new URL(`https://ops.test/api/health${query}`);
  return GET({ request, url } as never) as Promise<Response>;
}

describe("GET /api/health", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns 200 + minimal body { unhealthy:false } to an anonymous caller when healthy", async () => {
    vi.mocked(checkHealth).mockResolvedValue(FULL_REPORT as never);

    const res = await callGET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unhealthy: false }); // full report withheld — no recon
  });

  it("returns 503 to EVERYONE (auth-independent) when a check is firing, still minimal body", async () => {
    vi.mocked(checkHealth).mockResolvedValue({ ...FULL_REPORT, unhealthy: true } as never);

    const res = await callGET();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ unhealthy: true });
  });

  it("returns the FULL report to an authorized caller (correct token)", async () => {
    vi.stubEnv("HEALTH_PING_TOKEN", "s3cret");
    vi.mocked(checkHealth).mockResolvedValue(FULL_REPORT as never);

    const res = await callGET({ authorization: "Bearer s3cret" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FULL_REPORT); // backlog/suppression counts exposed only with the token
  });

  it("still gates the body to minimal for a wrong token even while returning the uptime status", async () => {
    vi.stubEnv("HEALTH_PING_TOKEN", "s3cret");
    vi.mocked(checkHealth).mockResolvedValue({ ...FULL_REPORT, unhealthy: true } as never);

    const res = await callGET({ authorization: "Bearer nope" });

    expect(res.status).toBe(503); // status leaks to everyone
    expect(await res.json()).toEqual({ unhealthy: true }); // body stays gated
  });
});
