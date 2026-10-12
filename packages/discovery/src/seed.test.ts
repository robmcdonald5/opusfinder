import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSeed } from "./seed";

describe("loadSeed", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries a transient 503 instead of failing the run on one bad GET", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json([{ ats_links: ["https://boards.greenhouse.io/acme"] }]));
    vi.stubGlobal("fetch", fetchMock);

    const promise = loadSeed("https://seed.test/companies_v2.json");
    await vi.runAllTimersAsync(); // the backoff sleep

    expect(await promise).toEqual([{ ats_links: ["https://boards.greenhouse.io/acme"] }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 200 whose body is cut mid-stream", async () => {
    vi.useFakeTimers();
    const cut = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("[{"));
        controller.error(new TypeError("terminated"));
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(cut, { status: 200 }))
      .mockResolvedValueOnce(Response.json([{ name: "acme" }]));
    vi.stubGlobal("fetch", fetchMock);

    const promise = loadSeed("https://seed.test/companies_v2.json");
    await vi.runAllTimersAsync();

    expect(await promise).toEqual([{ name: "acme" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
