/**
 * Integration suite for the REAL liveness probe (src/probe.ts `probeLiveness`) — the one unit that reaches
 * the network via the GLOBAL fetch with no DI seam, so it is covered under MSW (NOT the DI-stubbed
 * probeDigestLiveness in probe.test.ts). Proves the HEAD→GET fallback, the status→verdict classification,
 * the network-error → 'error' guard, and the 5s AbortController timeout → 'error' (via fake timers).
 * onUnhandledRequest:"error" (the integration setup) guarantees zero live egress.
 */
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { server } from "@test/msw/server";

import { probeLiveness } from "./probe";

const HOST = "https://jobs.test";

describe("probeLiveness — real fetch over MSW", () => {
  afterEach(() => vi.useRealTimers());

  it("classifies a 2xx HEAD as live", async () => {
    server.use(http.head(`${HOST}/live`, () => new HttpResponse(null, { status: 200 })));
    await expect(probeLiveness(`${HOST}/live`)).resolves.toEqual({ verdict: "live", status: 200 });
  });

  it("classifies a 404 as missing", async () => {
    server.use(http.head(`${HOST}/missing`, () => new HttpResponse(null, { status: 404 })));
    await expect(probeLiveness(`${HOST}/missing`)).resolves.toEqual({ verdict: "missing", status: 404 });
  });

  it("classifies a 410 as gone", async () => {
    server.use(http.head(`${HOST}/gone`, () => new HttpResponse(null, { status: 410 })));
    await expect(probeLiveness(`${HOST}/gone`)).resolves.toEqual({ verdict: "gone", status: 410 });
  });

  it("classifies a 5xx as error (ambiguous → keep)", async () => {
    server.use(http.head(`${HOST}/down`, () => new HttpResponse(null, { status: 503 })));
    await expect(probeLiveness(`${HOST}/down`)).resolves.toEqual({ verdict: "error", status: 503 });
  });

  it("classifies a non-404/410 4xx as error (keep, never close)", async () => {
    server.use(http.head(`${HOST}/forbidden`, () => new HttpResponse(null, { status: 403 })));
    await expect(probeLiveness(`${HOST}/forbidden`)).resolves.toEqual({ verdict: "error", status: 403 });
  });

  it("falls back to GET when HEAD is rejected 405, then classifies the GET status", async () => {
    server.use(
      http.head(`${HOST}/head-405`, () => new HttpResponse(null, { status: 405 })),
      http.get(`${HOST}/head-405`, () => new HttpResponse(null, { status: 200 })),
    );
    await expect(probeLiveness(`${HOST}/head-405`)).resolves.toEqual({ verdict: "live", status: 200 });
  });

  it("falls back to GET when HEAD is rejected 501, re-classifying a GET 404 as missing", async () => {
    server.use(
      http.head(`${HOST}/head-501`, () => new HttpResponse(null, { status: 501 })),
      http.get(`${HOST}/head-501`, () => new HttpResponse(null, { status: 404 })),
    );
    await expect(probeLiveness(`${HOST}/head-501`)).resolves.toEqual({ verdict: "missing", status: 404 });
  });

  it("treats a network error as error (never rejects)", async () => {
    server.use(http.head(`${HOST}/neterr`, () => HttpResponse.error()));
    await expect(probeLiveness(`${HOST}/neterr`)).resolves.toEqual({ verdict: "error" });
  });

  it("classifies a hung request as error via the 5s AbortController timeout", async () => {
    vi.useFakeTimers();
    server.use(http.head(`${HOST}/hang`, () => new Promise<never>(() => {}))); // never resolves
    const pending = probeLiveness(`${HOST}/hang`);
    await vi.advanceTimersByTimeAsync(5000); // fire the abort timer → fetch rejects → catch → 'error'
    await expect(pending).resolves.toEqual({ verdict: "error" });
  });
});
