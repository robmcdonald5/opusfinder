/**
 * Unit suite for the health GET route handler (+server.ts). The db + checkHealth are module-mocked (no real
 * Neon), @sveltejs/kit's `json` is stubbed to a plain Response, and isAuthorized reads HEALTH_PING_TOKEN.
 * Pins the axes the handler owns: report.unhealthy → 200/503 status (returned to EVERYONE), the body gate
 * (full report only when authorized, else the minimal `{ unhealthy }` — no operational-intel leak), and
 * that an anonymous hit only reaches Neon when a check enforces, and then at most once per memo window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkHealth, healthOptionsFromEnv } = vi.hoisted(() => ({
  checkHealth: vi.fn(),
  healthOptionsFromEnv: vi.fn(),
}));

vi.mock("@opusfinder/db", () => ({ createDb: vi.fn(() => ({})) }));
vi.mock("@opusfinder/db/env", () => ({ getDatabaseUrl: vi.fn(() => "postgres://stub") }));
vi.mock("@opusfinder/db/health", () => ({ checkHealth, healthOptionsFromEnv }));
vi.mock("@sveltejs/kit", () => ({
  json: (body: unknown, init?: { status?: number }) =>
    new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
}));

const FULL_REPORT = { unhealthy: false, embeddingBacklog: 5, bounceSuppressed: 2 };
const ENFORCING = { modes: { ingestion_staleness: "enforce" } };

let GET: typeof import("./+server").GET;

function callGET(headers: Record<string, string> = {}, query = ""): Promise<Response> {
  const request = new Request(`https://ops.test/api/health${query}`, { headers });
  const url = new URL(`https://ops.test/api/health${query}`);
  return GET({ request, url } as never) as Promise<Response>;
}

describe("GET /api/health", () => {
  beforeEach(async () => {
    vi.resetModules(); // a fresh route module per test, so the anonymous memo never carries over
    ({ GET } = await import("./+server"));
    checkHealth.mockReset();
    healthOptionsFromEnv.mockReturnValue({});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("answers an anonymous caller 200 { unhealthy:false } without querying Neon when no check enforces", async () => {
    const res = await callGET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unhealthy: false });
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it("returns 503 to EVERYONE (auth-independent) when an enforce check is firing, still minimal body", async () => {
    healthOptionsFromEnv.mockReturnValue(ENFORCING);
    checkHealth.mockResolvedValue({ ...FULL_REPORT, unhealthy: true });

    const res = await callGET();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ unhealthy: true });
  });

  it("re-checks for anonymous callers at most once per 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    healthOptionsFromEnv.mockReturnValue(ENFORCING);
    checkHealth
      .mockResolvedValueOnce(FULL_REPORT)
      .mockResolvedValueOnce({ ...FULL_REPORT, unhealthy: true });

    expect((await callGET()).status).toBe(200);
    vi.setSystemTime(new Date("2026-10-11T00:09:59Z"));
    expect((await callGET()).status).toBe(200);
    expect(checkHealth).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-10-11T00:10:00Z"));
    expect((await callGET()).status).toBe(503);
    expect(checkHealth).toHaveBeenCalledTimes(2);
  });

  it("returns the FULL report to an authorized caller (correct token)", async () => {
    vi.stubEnv("HEALTH_PING_TOKEN", "s3cret");
    checkHealth.mockResolvedValue(FULL_REPORT);

    const res = await callGET({ authorization: "Bearer s3cret" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FULL_REPORT); // backlog/suppression counts exposed only with the token
  });

  it("still gates the body to minimal for a wrong token even while returning the uptime status", async () => {
    vi.stubEnv("HEALTH_PING_TOKEN", "s3cret");
    healthOptionsFromEnv.mockReturnValue(ENFORCING);
    checkHealth.mockResolvedValue({ ...FULL_REPORT, unhealthy: true });

    const res = await callGET({ authorization: "Bearer nope" });

    expect(res.status).toBe(503); // status leaks to everyone
    expect(await res.json()).toEqual({ unhealthy: true }); // body stays gated
  });
});
